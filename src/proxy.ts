import NextAuth from "next-auth";
import authConfig from "@/lib/auth.config";

// Edge-safe: only the base config (no Credentials provider / Node deps).
const { auth } = NextAuth(authConfig);

export const proxy = auth;

export const config = {
  // Skip by directory, never by file extension: an extension exclusion
  // (`.*\.png$`) also skipped a POST to a dynamic page route like
  // /buckets/x.png, bypassing the demo-household POST block in
  // auth.config.ts. Every static image lives under /icons/.
  matcher: ["/((?!_next/static|_next/image|icons/).*)"],
};
