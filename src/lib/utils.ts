import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge tailwind classes — used by every shadcn primitive. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
