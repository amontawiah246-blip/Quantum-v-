let _active = false;
let _current: unknown = null;

// One switch shared by AutoTrade and the verification coordinator. ON = the agents' setups are verified (engines + AI) and may be traded.
// OFF = the agents keep watching and publishing exactly as before, but nothing is sent to Gemini and no order can follow.
export const agentMode = {
  get active(): boolean {
    return _active;
  },
  set active(val: boolean) {
    _active = val;
    if (!val) _current = null;
  },
  open(source: unknown) {
    _current = source;
    _active = true;
  },
  close(source: unknown) {
    if (_current === source || !_current) {
      _current = null;
      _active = false;
    }
  },
};

