import path from "node:path";
import { defineConfig, env } from "prisma/config";

// Prisma 7 no longer loads .env implicitly, so the config does it explicitly.
// The file is gitignored; .env.example documents every variable.
import "dotenv/config";

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
