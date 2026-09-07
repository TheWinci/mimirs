import { track } from "./analytics.js";

function label(value) {
  return value.toUpperCase();
}

export function Button({ children }) {
  const title = label(children);
  return <button title={title} onClick={() => track(title)}>{children}</button>;
}
