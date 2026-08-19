import { Router, type RequestHandler } from "express";
import multer from "multer";
import { MAX_UPLOAD_BYTES, CreateConceptSchema, UpdateConceptSchema, UuidParamSchema } from "@storyboards/shared";
import { AppError } from "../lib/AppError.js";
import * as concepts from "../services/concepts.js";

export const conceptsRouter: Router = Router();

// Memory storage: uploads are capped at 10 MB and go straight into sharp, so a
// disk round-trip would buy nothing.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    // A cheap reject for obvious mistakes. The declared MIME type is a hint
    // from the client and is never trusted -- sharp decoding the bytes is the
    // authoritative check.
    if (!file.mimetype.startsWith("image/")) {
      cb(new AppError(415, "unsupported_media_type", "Expected an image file"));
      return;
    }
    cb(null, true);
  },
});

/**
 * multer reports its own failures as MulterError, which would otherwise reach
 * the terminal error handler as an unrecognized throw and surface as a generic
 * 500 -- making the upload size limit invisible to the user.
 */
const uploadSingleImage: RequestHandler = (req, res, next) => {
  upload.single("image")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        next(new AppError(413, "file_too_large", `Image must be ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB or smaller`));
        return;
      }
      next(new AppError(400, "invalid_input", `Upload rejected: ${err.code}`));
      return;
    }
    next(err);
  });
};

conceptsRouter.get("/concepts", async (_req, res) => {
  res.json(await concepts.listConcepts());
});

conceptsRouter.post("/concepts", async (req, res) => {
  const body = CreateConceptSchema.parse(req.body);
  res.status(201).json(await concepts.createConcept(body));
});

conceptsRouter.get("/concepts/:id", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  res.json(await concepts.getConcept(id));
});

conceptsRouter.patch("/concepts/:id", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  const body = UpdateConceptSchema.parse(req.body);
  res.json(await concepts.updateConcept(id, body));
});

conceptsRouter.delete("/concepts/:id", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  await concepts.deleteConcept(id);
  res.status(204).end();
});

conceptsRouter.post("/concepts/:id/image", uploadSingleImage, async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  if (!req.file) {
    throw new AppError(415, "unsupported_media_type", "Expected a multipart form field named 'image'");
  }
  res.json(await concepts.setConceptImage(id, req.file.buffer));
});
