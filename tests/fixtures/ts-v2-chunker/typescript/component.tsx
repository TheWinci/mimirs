// @ts-nocheck -- standalone parser fixture; no UI runtime is installed.
import type { ReactNode } from "react";

interface CardProps {
  title: string;
  children: ReactNode;
}

function format(value: string): string {
  return value.toUpperCase();
}

export function Card({ title, children }: CardProps) {
  const label = format(title);
  return (
    <article className="card" aria-label={label}>
      <h2>{label}</h2>
      {children}
    </article>
  );
}
