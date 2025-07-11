import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import assert from "assert";
import type { S3Event, S3Handler } from "aws-lambda";
import sharp from "sharp";
import type { Readable } from "stream";

assert(process.env.OPTIMIZED_BUCKET_NAME, "OPTIMIZED_BUCKET_NAME must be set");

const OPTIMIZED_BUCKET = process.env.OPTIMIZED_BUCKET_NAME;
const MAX_WIDTH = 800;
const QUALITY = 85;

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-2",
});

const SUPPORTED_FORMATS = [".jpg", ".jpeg", ".png", ".webp", ".tiff", ".bmp"];

interface OptimizedImageResult {
  buffer: Buffer;
  contentType: string;
  size: number;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", (err) => reject(err));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function isSupportedImage(key: string): boolean {
  const extension = key.toLowerCase().substring(key.lastIndexOf("."));
  return SUPPORTED_FORMATS.includes(extension);
}

async function optimizeImage(
  buffer: Buffer,
  originalKey: string,
): Promise<OptimizedImageResult> {
  try {
    const image = sharp(buffer);
    const metadata = await image.metadata();

    console.log(
      `Original image: ${originalKey}, Format: ${metadata.format}, Size: ${metadata.width}x${metadata.height}`,
    );

    const processedImage = image.resize(MAX_WIDTH, null, {
      fit: "inside",
      withoutEnlargement: true,
    });

    let outputBuffer: Buffer;
    let contentType: string;

    if (metadata.format === "png" && metadata.hasAlpha) {
      // Keep PNG for transparency
      outputBuffer = await processedImage
        .png({
          quality: QUALITY,
          compressionLevel: 9,
        })
        .toBuffer();
      contentType = "image/png";
    } else {
      // Convert to WebP for better compression
      outputBuffer = await processedImage
        .webp({
          quality: QUALITY,
          effort: 6,
        })
        .toBuffer();
      contentType = "image/webp";
    }

    console.log(
      `Optimized image size: ${outputBuffer.length} bytes (${((outputBuffer.length / buffer.length) * 100).toFixed(2)}% of original)`,
    );

    return {
      buffer: outputBuffer,
      contentType,
      size: outputBuffer.length,
    };
  } catch (error) {
    console.error("Error optimizing image:", error);
    throw error;
  }
}

function generateOptimizedKey(
  originalKey: string,
  contentType: string,
): string {
  const lastDotIndex = originalKey.lastIndexOf(".");
  const baseName = originalKey.substring(0, lastDotIndex);

  if (contentType === "image/webp") {
    return `${baseName}.webp`;
  } else if (contentType === "image/png") {
    return `${baseName}.png`;
  }

  return originalKey;
}

export const handler: S3Handler = async (event: S3Event): Promise<void> => {
  console.log("Processing S3 event:", JSON.stringify(event, null, 2));

  const processingPromises = event.Records.map(async (record) => {
    const sourceBucket = record.s3.bucket.name;
    const sourceKey = decodeURIComponent(
      record.s3.object.key.replace(/\+/g, " "),
    );

    console.log(`Processing: ${sourceKey} from bucket: ${sourceBucket}`);

    if (!isSupportedImage(sourceKey)) {
      console.log(`Skipping unsupported file: ${sourceKey}`);
      return;
    }

    if (sourceBucket === OPTIMIZED_BUCKET) {
      console.log(`Skipping file already in optimized bucket: ${sourceKey}`);
      return;
    }

    try {
      const getObjectCommand = new GetObjectCommand({
        Bucket: sourceBucket,
        Key: sourceKey,
      });

      const { Body, Metadata } = await s3Client.send(getObjectCommand);

      if (!Body) {
        throw new Error("No body in S3 response");
      }

      const originalBuffer = await streamToBuffer(Body as Readable);
      const optimized = await optimizeImage(originalBuffer, sourceKey);
      const optimizedKey = generateOptimizedKey(
        sourceKey,
        optimized.contentType,
      );

      const putObjectCommand = new PutObjectCommand({
        Bucket: OPTIMIZED_BUCKET,
        Key: optimizedKey,
        Body: optimized.buffer,
        ContentType: optimized.contentType,
        Metadata: {
          ...Metadata,
          "original-size": originalBuffer.length.toString(),
          "optimized-size": optimized.size.toString(),
          "compression-ratio": (
            (optimized.size / originalBuffer.length) *
            100
          ).toFixed(2),
          "processed-at": new Date().toISOString(),
        },
        CacheControl: "public, max-age=31536000", // 1 year cache
      });

      await s3Client.send(putObjectCommand);

      console.log(`Successfully processed: ${sourceKey} -> ${optimizedKey}`);
      console.log(
        `Size reduction: ${originalBuffer.length} -> ${optimized.size} bytes`,
      );
    } catch (error) {
      console.error(`Error processing ${sourceKey}:`, error);
      throw error; // Re-throw to trigger Lambda retry
    }
  });

  await Promise.all(processingPromises);

  console.log("All images processed successfully");
};

export { generateOptimizedKey, isSupportedImage, optimizeImage };
