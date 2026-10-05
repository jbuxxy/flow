"use client";

import { useState, forwardRef } from "react";
import { Eye, EyeOff } from "lucide-react";

export type PasswordInputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className = "", type: _type, ...props }, ref) => {
    const [showPassword, setShowPassword] = useState(false);

    return (
      <div className="relative flex items-center w-full">
        <input
          {...props}
          ref={ref}
          type={showPassword ? "text" : "password"}
          className={`w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-[var(--background)] px-3 py-2.5 pr-16 text-base font-normal focus:border-blue-900 focus:outline-none ${className}`}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setShowPassword((prev) => !prev)}
          className="absolute right-2.5 z-20 flex h-7 w-7 items-center justify-center rounded text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 focus:outline-none transition-colors"
          aria-label={showPassword ? "Hide password" : "Show password"}
          title={showPassword ? "Hide password" : "Show password"}
        >
          {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
    );
  },
);

PasswordInput.displayName = "PasswordInput";
