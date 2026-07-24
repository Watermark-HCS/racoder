import http from "node:http";
import { spawn } from "node:child_process";
import { getTimeZone, log, LOG_LEVELS, validateEnv } from "./utils.js";

const { BITRATE, HTTP_PORT, INPUT_STREAM, OUTPUT_PATH } = validateEnv();
const SHUTDOWN_TIMEOUT = 5000;
const MAX_CLIENT_BUFFER = 4 * 1024 * 1024;
const INPUT_STREAMS = INPUT_STREAM.split("|");
const OUTPUT_PATHS = OUTPUT_PATH.split("|");

if (INPUT_STREAMS.length !== OUTPUT_PATHS.length) {
    throw new Error(
        "INPUT_STREAM and OUTPUT_PATH must have the same number of entries."
    );
}

function trim_trailing_slash(val) {
    if (val.length > 1 && val[val.length - 1] == "/") {
        val = val.slice(0, -1);
    }
    return val;
}

/** @type {Record<string, string>} */
var STREAMS = {};
OUTPUT_PATHS.forEach((element, index) => {
    STREAMS[element] = trim_trailing_slash(INPUT_STREAMS[index]);
});

/**
 * @typedef {Object} ActiveStream
 * @property {import("node:child_process").ChildProcessWithoutNullStreams | null} ffmpegProcess
 * @property {Set<import("node:http").ServerResponse>} clients
 */

// One entry per output path with at least one connected client
/** @type {Map<string, ActiveStream>} */
const ACTIVE_STREAMS = new Map();

/**
 * @param {ActiveStream} stream
 * @param {string} path
 * @param {string} stream_url
 * @param {number} [retries]
 */
function spawnFFmpeg(stream, path, stream_url, retries = 3) {
    const ffmpegProcess = spawn("ffmpeg", [
        "-nostdin",
        "-loglevel",
        "warning",
        "-re",
        "-i",
        stream_url,
        "-vn",
        "-c:a",
        "libmp3lame",
        "-b:a",
        BITRATE,
        "-f",
        "mp3",
        "pipe:1",
    ]);
    stream.ffmpegProcess = ffmpegProcess;

    log(
        `Spawned FFmpeg process with PID '${ffmpegProcess.pid}' for '${path}'`
    );

    ffmpegProcess.stdout.on("data", (chunk) => {
        for (const res of stream.clients) {
            if (res.writableLength > MAX_CLIENT_BUFFER) {
                log(`Dropping client too slow to keep up with '${path}'`);
                stream.clients.delete(res);
                res.destroy();
                continue;
            }
            res.write(chunk);
        }
    });

    ffmpegProcess.stderr.on("data", (data) => {
        log(`stdout: ${data}`, LOG_LEVELS.DEBUG);
    });

    ffmpegProcess.on("error", (error) => {
        if (retries > 0) {
            log(
                `Retrying FFmpeg process for URL '${stream_url}' (${retries} retries left)`
            );
            setTimeout(() => {
                if (
                    ACTIVE_STREAMS.get(path) === stream &&
                    stream.clients.size > 0
                ) {
                    spawnFFmpeg(stream, path, stream_url, retries - 1);
                }
            }, 1000);
        } else {
            log(
                `FFmpeg process failed for URL '${stream_url}' after retries: ${error}`
            );
            endStream(path, stream);
        }
    });

    ffmpegProcess.on("close", (code) => {
        log(
            `FFmpeg process with PID '${ffmpegProcess.pid}' exited with code ${code}`
        );
        endStream(path, stream);
    });
}

/**
 * @param {string} path
 * @param {ActiveStream} stream
 */
function endStream(path, stream) {
    if (ACTIVE_STREAMS.get(path) === stream) {
        ACTIVE_STREAMS.delete(path);
    }
    for (const res of stream.clients) {
        res.end();
    }
    stream.clients.clear();
}

function handleStream(req, res) {
    log(`Incoming request for URL '${req.url}' with method '${req.method}'`);
    log(`Incoming request headers: ${req.rawHeaders}`, LOG_LEVELS.DEBUG);
    res.writeHead(200, { "Content-Type": "audio/mpeg" });

    const path = trim_trailing_slash(req.url);
    const stream_url = STREAMS[path];

    let stream = ACTIVE_STREAMS.get(path);
    if (stream == null) {
        stream = { ffmpegProcess: null, clients: new Set() };
        ACTIVE_STREAMS.set(path, stream);
        spawnFFmpeg(stream, path, stream_url);
    } else {
        log(
            `Reusing FFmpeg process with PID '${stream.ffmpegProcess.pid}' for '${path}' (${stream.clients.size + 1} clients)`
        );
    }

    stream.clients.add(res);

    res.on("error", (/** @type {Error} */ error) => {
        log(`Client connection error on '${path}': ${error}`, LOG_LEVELS.DEBUG);
        stream.clients.delete(res);
        res.destroy();
    });

    req.on("close", () => {
        stream.clients.delete(res);
        if (stream.clients.size === 0 && ACTIVE_STREAMS.get(path) === stream) {
            log(
                `Last client disconnected from '${path}'. Quitting FFmpeg process with PID '${stream.ffmpegProcess.pid}' …`,
                LOG_LEVELS.DEBUG
            );
            ACTIVE_STREAMS.delete(path);
            stream.ffmpegProcess.kill();
        }
    });
}

function handleHealthcheck(req, res) {
    log("Healthcheck probed", LOG_LEVELS.DEBUG);
    res.writeHead(200);
    res.end();
}

function handleNotFound(req, res) {
    log(`404 Invalid URL: '${req.url}'`);
    res.writeHead(404);
    res.end();
}

function gracefulShutdown(signal) {
    log(`${signal} received. Stopping server …`);
    for (const [path, stream] of ACTIVE_STREAMS) {
        log(
            `Quitting FFmpeg process with PID '${stream.ffmpegProcess.pid}' for '${path}' …`,
            LOG_LEVELS.DEBUG
        );
        stream.ffmpegProcess.kill();
    }
    server.close(() => {
        process.exit(0);
    });
    setTimeout(() => {
        log("Timeout reached. Shutting down server now …");
        process.exit(1);
    }, SHUTDOWN_TIMEOUT);
}

const server = http.createServer(
    { keepAlive: true, keepAliveInitialDelay: 5000 },
    (req, res) => {
        const req_url = trim_trailing_slash(req.url);
        if (req_url in STREAMS) {
            handleStream(req, res);
        } else if (req_url == "/healthcheck") {
            handleHealthcheck(req, res);
        } else {
            handleNotFound(req, res);
        }
    }
);

log(`Server timezone: ${getTimeZone()}`);
server.listen(HTTP_PORT);
log(`Server listening on TCP port ${HTTP_PORT} …`);

OUTPUT_PATHS.forEach((path, index) => {
    const inputStream = INPUT_STREAMS[index];
    log(`Stream from '${inputStream}' available at '${path}'`);
});

process.on("SIGINT", (signal) => gracefulShutdown(signal));
process.on("SIGTERM", (signal) => gracefulShutdown(signal));
