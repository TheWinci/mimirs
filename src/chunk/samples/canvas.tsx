import React, { useState } from "react";

type Props = { label: string };

export const Button = ({ label }: Props) => {
  const [pressed, setPressed] = useState(false);
  const handleClick = () => setPressed(true);
  return <button onClick={handleClick}>{label}</button>;
};

class Canvas extends React.Component<Props> {
  state = { zoom: 1 };

  private handleWheel = (event: WheelEvent) => {
    this.setState({ zoom: this.state.zoom + event.deltaY });
  };

  render() {
    return <canvas onWheel={this.handleWheel} />;
  }
}

export default Canvas;
