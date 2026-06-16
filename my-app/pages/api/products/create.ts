import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import { prisma } from "../../../lib/prisma";
import { v2 as cloudinary } from "cloudinary";
import formidable, { File, Fields, Files } from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false,
  },
};

// ---------------- CLOUDINARY CONFIG ----------------
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME!,
  api_key: process.env.API_KEY!,
  api_secret: process.env.API_SECRET!,
});

// ---------------- TYPES ----------------
interface FormFields {
  title: string;
  description?: string;
  price: string;
  quantity: string;
  colors?: string[];
  sizes?: string[];
  categories?: string[];
  condition?: string;
  era?: string;
}

// ---------------- HELPERS ----------------
const normalizeField = (field?: string | string[]): string[] =>
  !field ? [] : Array.isArray(field) ? field.map(String) : [String(field)];

const splitComma = (field?: string[]): string[] =>
  field?.flatMap((f) => f.split(",").map((s) => s.trim())) || [];

// ---------------- FORM PARSER ----------------
const parseForm = (
  req: NextApiRequest
): Promise<{ fields: FormFields; files: File[] }> =>
  new Promise((resolve, reject) => {
    const form = formidable({
      multiples: true,
      maxFileSize: 10 * 1024 * 1024, // 10MB safety limit
    });

    form.parse(req, (err, fields: Fields, files: Files) => {
      if (err) return reject(err);

      const uploadedFiles: File[] = [];

      const imageField = files.images;
      if (imageField) {
        if (Array.isArray(imageField)) {
          uploadedFiles.push(...(imageField as File[]));
        } else {
          uploadedFiles.push(imageField as File);
        }
      }

      const safeFields: FormFields = {
        title: fields.title?.toString() || "",
        description: fields.description?.toString(),
        price: fields.price?.toString() || "0",
        quantity: fields.quantity?.toString() || "1",
        colors: splitComma(normalizeField(fields.colors)),
        sizes: splitComma(normalizeField(fields.sizes)),
        condition: fields.condition?.toString(),
        era: fields.era?.toString(),
        categories: (() => {
          try {
            return JSON.parse(fields.categories?.toString() || "[]");
          } catch {
            return [];
          }
        })(),
      };

      resolve({ fields: safeFields, files: uploadedFiles });
    });
  });

// ---------------- CLOUDINARY UPLOAD ----------------
const uploadFileToCloudinary = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    if (!file.filepath) return reject(new Error("Missing file path"));

    const stream = cloudinary.uploader.upload_stream(
      { folder: "zamzam-products" },
      (err, result) => {
        if (err || !result?.secure_url) {
          return reject(err || new Error("Cloudinary upload failed"));
        }
        resolve(result.secure_url);
      }
    );

    fs.createReadStream(file.filepath).pipe(stream);
  });

// ---------------- HANDLER ----------------
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const session = await getServerSession(req, res, authOptions);

    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { fields, files } = await parseForm(req);

    const {
      title,
      description,
      price,
      quantity,
      colors,
      sizes,
      categories,
      condition,
      era,
    } = fields;

    // ---------------- VALIDATION ----------------
    if (!title || !price || !quantity) {
      return res.status(400).json({
        error: "Missing required fields",
        debug: fields,
      });
    }

    if (!files || files.length === 0) {
      return res.status(400).json({
        error: "At least one image is required",
      });
    }

    const userId = (session.user as { id?: string })?.id;

    if (!userId) {
      return res.status(401).json({
        error: "User ID not found in session",
      });
    }

    console.log("FILES:", files.length);
    console.log("TITLE:", title);

    // ---------------- UPLOAD IMAGES ----------------
    const imageUrls: string[] = [];

    for (const file of files) {
      try {
        const url = await uploadFileToCloudinary(file);
        imageUrls.push(url);
      } catch (err) {
        console.error("Cloudinary upload failed:", err);
        return res.status(500).json({
          error: "Image upload failed",
        });
      }
    }

    // ---------------- CREATE PRODUCT ----------------
    const product = await prisma.product.create({
      data: {
        title,
        description: description || "",
        price: parseFloat(price),
        quantity: parseInt(quantity, 10),
        colors,
        sizes,
        condition: condition || "",
        era: era || "",
        ownerId: userId,
        images: imageUrls,
      },
    });

    // ---------------- CATEGORIES ----------------
    if (categories?.length) {
      await Promise.all(
        categories.map((catId) =>
          prisma.productCategory.create({
            data: {
              productId: product.id,
              categoryId: catId,
            },
          })
        )
      );
    }

    return res.status(201).json({
      success: true,
      productId: product.id,
      imageUrls,
    });
  } catch (error) {
    console.error("CREATE PRODUCT ERROR:", error);

    return res.status(500).json({
      error: "Internal server error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}