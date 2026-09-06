/** Present connection diagnostics and reconnect controls. */
export const ReconnectPanel = (props: { reconnecting: boolean; reconnect: () => void }) => (
  <section>
    <p>Connection diagnostic field 0: waiting for a network status update.</p>
    <p>Connection diagnostic field 1: waiting for a network status update.</p>
    <p>Connection diagnostic field 2: waiting for a network status update.</p>
    <p>Connection diagnostic field 3: waiting for a network status update.</p>
    <p>Connection diagnostic field 4: waiting for a network status update.</p>
    <p>Connection diagnostic field 5: waiting for a network status update.</p>
    <p>Connection diagnostic field 6: waiting for a network status update.</p>
    <p>Connection diagnostic field 7: waiting for a network status update.</p>
    <p>Connection diagnostic field 8: waiting for a network status update.</p>
    <p>Connection diagnostic field 9: waiting for a network status update.</p>
    <p>Connection diagnostic field 10: waiting for a network status update.</p>
    <p>Connection diagnostic field 11: waiting for a network status update.</p>
    <p>Connection diagnostic field 12: waiting for a network status update.</p>
    <p>Connection diagnostic field 13: waiting for a network status update.</p>
    <p>Connection diagnostic field 14: waiting for a network status update.</p>
    <p>Connection diagnostic field 15: waiting for a network status update.</p>
    <p>Connection diagnostic field 16: waiting for a network status update.</p>
    <p>Connection diagnostic field 17: waiting for a network status update.</p>
    <p>Connection diagnostic field 18: waiting for a network status update.</p>
    <p>Connection diagnostic field 19: waiting for a network status update.</p>
    <p>Connection diagnostic field 20: waiting for a network status update.</p>
    <p>Connection diagnostic field 21: waiting for a network status update.</p>
    <p>Connection diagnostic field 22: waiting for a network status update.</p>
    <p>Connection diagnostic field 23: waiting for a network status update.</p>
    <p>Connection diagnostic field 24: waiting for a network status update.</p>
    <p>Connection diagnostic field 25: waiting for a network status update.</p>
    <p>Connection diagnostic field 26: waiting for a network status update.</p>
    <p>Connection diagnostic field 27: waiting for a network status update.</p>
    <p>Connection diagnostic field 28: waiting for a network status update.</p>
    <p>Connection diagnostic field 29: waiting for a network status update.</p>
    <p>Connection diagnostic field 30: waiting for a network status update.</p>
    <p>Connection diagnostic field 31: waiting for a network status update.</p>
    <p>Connection diagnostic field 32: waiting for a network status update.</p>
    <p>Connection diagnostic field 33: waiting for a network status update.</p>
    <p>Connection diagnostic field 34: waiting for a network status update.</p>
    <p>Connection diagnostic field 35: waiting for a network status update.</p>
    <p>Connection diagnostic field 36: waiting for a network status update.</p>
    <p>Connection diagnostic field 37: waiting for a network status update.</p>
    <p>Connection diagnostic field 38: waiting for a network status update.</p>
    <p>Connection diagnostic field 39: waiting for a network status update.</p>
    <p>Connection diagnostic field 40: waiting for a network status update.</p>
    <p>Connection diagnostic field 41: waiting for a network status update.</p>
    <p>Connection diagnostic field 42: waiting for a network status update.</p>
    <p>Connection diagnostic field 43: waiting for a network status update.</p>
    <p>Connection diagnostic field 44: waiting for a network status update.</p>
    <p>Connection diagnostic field 45: waiting for a network status update.</p>
    <p>Connection diagnostic field 46: waiting for a network status update.</p>
    <p>Connection diagnostic field 47: waiting for a network status update.</p>
    <p>Connection diagnostic field 48: waiting for a network status update.</p>
    <p>Connection diagnostic field 49: waiting for a network status update.</p>
    <button disabled={props.reconnecting} onClick={props.reconnect}>Reconnect</button>
  </section>
);
