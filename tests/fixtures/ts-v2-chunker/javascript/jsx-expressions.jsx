import { Card, formatTitle, makeProps, renderItem } from "./ui.js";

function propsFor(value) {
  return makeProps(value);
}

export function Gallery({ items, onSelect }) {
  const first = items.at(0);
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
