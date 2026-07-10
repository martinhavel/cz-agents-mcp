declare module 'stream-json' {
  export function parser(): NodeJS.ReadWriteStream;
}

declare module 'stream-json/streamers/StreamArray.js' {
  export function streamArray(): NodeJS.ReadWriteStream;
}

declare module 'unzipper' {
  const unzipper: {
    ParseOne(): NodeJS.ReadWriteStream;
  };
  export default unzipper;
}
