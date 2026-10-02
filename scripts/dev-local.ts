import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
process.env.LOCAL_MEDIA_IMPORT = "true";
process.env.VITE_DISABLE_FIREBASE_AUTH = "true";
process.env.FIREBASE_AUTH_REQUIRED = "false";
process.env.HOST = "127.0.0.1";
await import("../server");
