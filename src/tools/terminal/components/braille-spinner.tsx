import { cn } from "@zen-tools/ui";
import "./braille-spinner.css";

interface BrailleSpinnerProps {
  className?: string;
}

export function BrailleSpinner({ className }: BrailleSpinnerProps) {
  return (
    <span
      aria-hidden
      className={cn("terminal-braille-spinner", className)}
    />
  );
}
