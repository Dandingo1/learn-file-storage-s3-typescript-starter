import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { S3Client, write, type BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { mediaTypeToExt } from "./thumbnails";
import { randomBytes } from "node:crypto";
import { getVideo, updateVideo } from "../db/videos";

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
  if(!(uploadedVideo instanceof File) || uploadedVideo.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Something went wrong with the video upload with either the type or size");
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
  const filePath = `${cfg.assetsRoot}/${randomUrl}.${extension}`;
  Bun.write(filePath, uploadedVideo);

  const bunFile = Bun.file(filePath);

  const s3Key = `${randomUrl}.${extension}`;
  const s3File = S3Client.file(s3Key, { type: uploadedVideo.type });
  await s3File.write(bunFile);
  
  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${s3Key}`;
  updateVideo(cfg.db, video);

  await bunFile.delete();
  return respondWithJSON(200, video);
}
