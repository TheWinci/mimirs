import { useState } from "react";

export default function Menu({ items }) {
  const [open, setOpen] = useState(false);
  return <ul>{open && items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

export const MenuItem = ({ label }) => <li>{label}</li>;
