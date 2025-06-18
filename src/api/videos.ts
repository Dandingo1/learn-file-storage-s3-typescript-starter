import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { readableStreamToText, S3Client, type BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { mediaTypeToExt } from "./thumbnails";
import { randomBytes } from "node:crypto";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { rm } from "node:fs/promises";

const MAX_UPLOAD_SIZE = 1 << 30;

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
	const { videoId } = req.params as { videoId?: string };
	if (!videoId) {
		throw new BadRequestError("Invalid video ID");
	}

	const token = getBearerToken(req.headers);
	const userId = validateJWT(token, cfg.jwtSecret);

	console.log("uploading video ", videoId, "by user ", userId);

	const formData = await req.formData();
	const uploadedVideo = formData.get("video");
	if (
		!(uploadedVideo instanceof File) ||
		uploadedVideo.size > MAX_UPLOAD_SIZE
	) {
		throw new BadRequestError(
			"Something went wrong with the video upload with either the type or size"
		);
	}

	const extension = mediaTypeToExt(uploadedVideo.type);
	if (!uploadedVideo.type || uploadedVideo.type !== "video/mp4") {
		throw new BadRequestError("Missing or Wrong Content-Type for video");
	}

	const video = getVideo(cfg.db, videoId);
	if (video?.userID !== userId) {
		throw new UserForbiddenError("Not the owner of the video");
	}

	const randomUrl = randomBytes(32).toString("base64url");
	const filePath = `${cfg.assetsRoot}/${randomUrl}`;
	Bun.write(filePath, uploadedVideo);

  // Obtain aspect ratio from file passing the filePath argument
  const aspectRatio = await getVideoAspectRatio(filePath);

  const processedFilePath = await processVideoForFastStart(filePath);
  const processedFile = Bun.file(processedFilePath);

	const s3Key = `${aspectRatio}/${randomUrl}.${extension}`;
	const s3File = S3Client.file(s3Key, { type: uploadedVideo.type });
	await s3File.write(processedFile);

  video.videoURL = s3Key;
  updateVideo(cfg.db, video);

  await Promise.all([
    rm(filePath, { force: true }),
    rm(`${filePath}.processed.mp4`, { force: true }),
  ]);
  return respondWithJSON(200, video);
}

type Aspect = {
  width: number;
  height: number;
}

type Stream = {
  programs: unknown[];
  stream_groups: unknown[];
  streams: Aspect[];
}

async function getVideoAspectRatio(filePath: string): Promise<string> {
  const commands = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json ${filePath}`.split(" ");
  const subprocess = Bun.spawn({
    cmd: commands,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await readableStreamToText(subprocess.stdout); 
  const stderr = await readableStreamToText(subprocess.stderr);

  if (stderr && !stderr.includes("0")) {
    throw new Error("Something went wrong with the upload");
  }

  const stream: Stream = JSON.parse(stdout);
  const {width, height} = stream.streams[0];

  const aspect = (width/height).toFixed(4);
  if (aspect === "0.5630") return "portrait";
  else if (aspect === "1.7778") return "landscape";
  else return "other"
}

async function processVideoForFastStart(inputFilePath: string): Promise<string> {
  const processedFilePath = inputFilePath + ".processed.mp4";
  const commands = `ffmpeg -i ${inputFilePath} -movflags faststart -map_metadata 0 -codec copy -f mp4 ${processedFilePath}`.split(" ");
  const subprocess = Bun.spawn({
    cmd: commands,
    stderr: "pipe"
  });

  const stderr = await readableStreamToText(subprocess.stderr);
  if (stderr && !stderr.includes("0")) {
    throw new Error("Something went wrong with the upload");
  }

  return processedFilePath;
}

function generatePresignedURL(cfg: ApiConfig, key: string, expireTime: number): string {
  return S3Client.presign(key, {
    ...cfg,
    expiresIn: expireTime
  });
}

export function dbVideoToSignedVideo(cfg: ApiConfig, video: Video): Video {
  const presignUrl = generatePresignedURL(cfg, video.videoURL || "", 5 * 60);
  video.videoURL = presignUrl;
  return video;
}

