declare function parse(input: string): string;
declare function parse(input: Uint8Array): string;

declare abstract class Transport {
  static readonly protocol: string;
  abstract send(payload: Uint8Array): Promise<void>;
  close(): void;
}

declare namespace Protocol {
  type Version = 1 | 2;

  interface Message {
    version: Version;
    payload: Uint8Array;
  }

  function encode(message: Message): Uint8Array;
}

export { parse, Transport, Protocol };
