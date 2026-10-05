import { z } from "zod";

export const registerSchema = z.object({
  householdName: z.string().trim().min(2).max(80),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254).transform((v) => v.toLowerCase()),
  password: z.string().min(12).max(200),
});

// The invitee's own name/email/password, set together via their one-time
// setup link (see setAccountDetails, src/app/setup-totp/actions.ts) —
// replaces the old flow where the inviting owner filled in someone else's
// identity and invented a password for them.
export const accountDetailsSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(254).transform((v) => v.toLowerCase()),
    password: z.string().min(12).max(200),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export const totpVerifySchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code"),
});
