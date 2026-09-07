// @ts-nocheck -- standalone parser fixture; no UI runtime is installed.
import { Card, formatTitle, makeProps, renderItem } from "./ui.js";

interface GalleryProps {
  items: string[];
  onSelect: (item: string) => void;
}

function propsFor(value: string) {
  return makeProps(value);
}

export function Gallery({ items, onSelect }: GalleryProps) {
  const first = items.at(0)!;
  return (
    <>
      <Card
        {...propsFor(first)}
        title={formatTitle(first)}
        onClick={() => onSelect(first)}
      >
        <Card.Header />
        {items.map((item) => renderItem(item))}
      </Card>
    </>
  );
}
