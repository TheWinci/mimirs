import { h } from "./runtime";
/** Render the supplied label in a button. */
export const Button = <T,>(props: { label: T }) => <button>{String(props.label)}</button>;
export default class {
  render() { return <><Button label="café" /></>; }
}
