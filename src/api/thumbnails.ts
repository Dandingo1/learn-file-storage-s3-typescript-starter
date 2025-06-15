import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo, type Video } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

const MAX_UPLOAD_SIZE = 10 << 20;

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const thumbnail =  formData.get("thumbnail");
  if(!(thumbnail instanceof File) || thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Something went wrong with the thumbnail upload");
  }

  const mediaType = thumbnail.type;
  if (!mediaType) {
    throw new BadRequestError("Missing Content-Type for thumbnail");
  }

  const extension = mediaTypeToExt(mediaType);
  const fileName = `${videoId}${extension}`;

  // const data = await thumbnail.arrayBuffer();
  // const buffer = Buffer.from(data).toString("base64");
  // const dataURL = `data:${mediaType};base64,${buffer}`;

  const video = getVideo(cfg.db, videoId);
  if (video?.userID !== userID) {
    throw new UserForbiddenError("Not the owner of the video");
  }

  // videoThumbnails.set(videoId, {data, mediaType});

  // const thumbnailURL = `http://localhost:${cfg.port}/api/thumbnails/${videoId}`;
  // const thumbnailURL = `http://localhost:${cfg.port}/assets/${videoId}.${mediaType}`;

  const filePath = `${cfg.assetsRoot}/${videoId}.${extension}`;
  Bun.write(filePath, thumbnail);

  video.thumbnailURL = `http://localhost:${cfg.port}/assets/${videoId}.${mediaType}`;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video );
}

function mediaTypeToExt(mediaType: string) {
  const parts = mediaType.split("/");
    if (parts.length !== 2) {
      return ".bin";
    }
    return parts[1];
}