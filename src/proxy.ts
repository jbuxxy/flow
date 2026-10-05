import NextAuth from "next-auth";
import authConfig from "@/lib/auth.config";

// Edge-safe: only the base config (no Credentials provider / Node deps).
const { auth } = NextAuth(authConfig);

export const proxy = auth;

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.png$|.*\\.svg$).*)"],
};
