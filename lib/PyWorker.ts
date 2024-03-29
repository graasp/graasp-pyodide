/*

Test of pyodide, with
	- stdout and stderr collected and displayed in a pre element
	- error message sent to stderr
	- last result displayed with sys.displayhook
	- dynamic loading of modules referenced by import statements
	- file support
	- runs asynchronously in a webworker, with timeout and interruption

Author: Yves Piguet, EPFL, 2019-2020

Usage:

let pyWorker = new PyWorker();
pyWorker.onStatusChanged = (statusString) => { ... };
pyWorker.onTerminated = () => { ... };
pyWorker.sharedOutput = b; // default is false (see below)
pyWorker.onOutput = (text, append) => { ... };
pyWorker.onInput = (prompt) => { ... };
pyWorker.onFigure = (imageDataURL) => { ... }
pyWorker.onTimeout = () => { ... };
pyWorker.onDirtyFile = (path) => { ... };
pyWorker.onFile = (path, data) => { ... };
pyWorker.onError = (event) => { ... };
pyWorker.addCommand("name", (data) => { ... });

pyWorker.preload();	// optional

pyWorker.run("...");
pyWorker.stop();

Note on sharedOutput: if output is modified directly by the application,
e.g. for user input or to display other information, inline graphics etc.,
sharedOutput should be set to true and onOutput will be called with append=true;
otherwise, sharedOutput can be left to its default value of false, and onOutput
will always be called with append=false.

*/

import { PyodideStatus } from './types';
// import { getWrappedWorkerCode } from './utils';
// import { getPythonWorkerCode } from './webWorkerLocal';
import FullWorker from './fullWorker.js?worker&inline';

class PyWorker {
  workerURL?: string;
  worker: Worker | null;
  isRunning: boolean;
  isSuspended: boolean;
  // maximum allowed time to load packages in seconds
  maxTimeout: number;
  // id of the setTimeout function to cancel a running timeout
  timeoutId: number;
  // buffer for output
  outputBuffer: string;
  // share output
  sharedOutput: boolean;
  // debugger current line
  dbgCurrentLine: number | null;
  // packages to pre-load on startup
  preLoadedPackages: string[];

  // callbacks
  onOutput: ((outputBuffer: string, append: boolean) => void) | null;
  onInput: ((prompt: string) => void) | null;
  onFigure: ((data: string) => void) | null;
  onTimeout: (() => void) | null;
  onDirtyFile: ((data: unknown) => void) | null;
  onStatusUpdate: ((status: PyodideStatus) => void) | null;
  onReceivePyFile: ((path: string, data: unknown) => void) | null;
  // called when the worker is done
  onTerminated: (() => void) | null | undefined;
  // called when an error is detected
  onError: ((error: ErrorEvent) => void) | null;

  //  --- private arguments ---
  // called to announce a status change
  // private onStatusChanged: ((status: string) => void) | null;
  // Commands that can be used from the worker with 'sendCommand(name, data)'
  // and from python with 'import js; js.sendCommand(name, data)'
  private commands: { [key: string]: Function };
  private webworkerStatus: string;

  /**
   * PyWorker is the class encapsulating the pyodide worker functionality
   * @param workerURL url of the worker code, uses default code if omitted
   */
  constructor(workerURL?: string) {
    this.workerURL = workerURL;
    this.worker = null;
    this.isRunning = false;
    this.isSuspended = false;
    this.maxTimeout = 180; // seconds (should be enough for numpy + scipy + matplotlib)
    this.timeoutId = -1;
    this.outputBuffer = '';
    this.sharedOutput = false; // onOutput always called with append=false
    this.dbgCurrentLine = null;
    // packages to load by default
    this.preLoadedPackages = [];

    // callbacks
    this.onError = null; // default: console.info
    this.onOutput = null;
    this.onInput = null;
    this.onFigure = null;
    this.onTimeout = null;
    this.onDirtyFile = null;
    this.onReceivePyFile = null;
    this.onStatusUpdate = null; // default: console
    this.onTerminated = null;

    // commands added by addCommand(name, (data) => { ... })
    // (can be called from webworker with sendCommand;
    // from Python, with import js; js.sendCommand(name, data) )
    this.commands = {};
    this.webworkerStatus = 'idle';
  }

  /**
   * Add a custom command that can be called from the WebWorker or from python:
   *
   * ```py
   * import js
   * js.sendCommand(name, data)
   * ```
   * @param name string identifier for the command
   * @param func callback function associated with the command
   */
  addCommand(name: string, func: Function) {
    this.commands[name] = func;
  }

  stop() {
    if (this.worker != null) {
      this.worker.terminate();
      this.worker = null;
      this.isRunning = false;
      this.onTerminated && this.onTerminated();
    }
  }

  create() {
    this.stop();
    // if worker code can not be imported because of access policies try wrapping it in a `importScripts`
    try {
      // if this line errors in tests, make sure you are not importing this module in your tests,
      // the "import.meta.url" syntax is not compatible with server-side code (used by tests)
      this.worker = new FullWorker();
    } catch (error) {
      console.log(error);
      if (this.workerURL) {
        this.worker = new Worker(this.workerURL);
      }
    }
    this.isRunning = false;
    this.worker?.addEventListener('message', (ev) => {
      switch (ev.data.cmd) {
        case 'print':
          this.printToOutput(ev.data.data);
          break;
        case 'clear':
          this.clearOutput();
          break;
        case 'figure':
          this.onFigure?.(ev.data.data);
          break;
        case 'dirty':
          this.onDirtyFile?.(ev.data.data);
          break;
        case 'file':
          this.onReceivePyFile?.(ev.data.path, ev.data.data);
          break;
        case 'input':
          this.isRunning = false;
          this.webworkerStatus = 'input';
          this.onStatusChanged?.('input');
          this.onInput?.(ev.data.prompt);
          break;
        case 'status':
          this.webworkerStatus = ev.data.status;
          this.onStatusChanged?.(this.webworkerStatus);
          break;
        case 'done':
          this.isRunning = false;
          this.isSuspended = ev.data.suspendedAt != null;
          this.dbgCurrentLine = ev.data.suspendedAt;
          this.webworkerStatus = 'idle';
          this.onStatusChanged?.('done');
          this.onTerminated?.();
          break;
        default:
          if (
            ev.data.cmd.slice(0, 4) === 'cmd:' &&
            this.commands[ev.data.cmd.slice(4)]
          ) {
            this.commands[ev.data.cmd.slice(4)](ev.data.data);
          }
          break;
      }
    });
    this.worker?.addEventListener('error', (ev) => {
      if (this.onError) {
        this.onError(ev);
      } else {
        console.info(ev);
      }
    });

    const msg = {
      cmd: 'config',
      options: {
        handleInput: true,
        inlineInput: this.sharedOutput,
        preLoadedPackages: this.preLoadedPackages,
      },
    };
    console.log('preloaded packages in PyWorker: ', this.preLoadedPackages);

    this.worker?.postMessage(JSON.stringify(msg));
  }

  handleTimeout() {
    if (this.maxTimeout >= 0) {
      if (this.timeoutId >= 0) {
        clearTimeout(this.timeoutId);
      }
      this.timeoutId = window.setTimeout(() => {
        if (this.isRunning) {
          this.stop();
          this.onStatusChanged && this.onStatusChanged('timeout');
          this.onTimeout && this.onTimeout();
        }
        this.timeoutId = -1;
      }, 1000 * this.maxTimeout);
    }
  }

  run(src: string | null, breakpoints: number[] = []) {
    if (this.worker == null || this.isRunning) {
      this.create();
    }
    const msg =
      src != null
        ? {
            cmd: 'run',
            code: src,
            breakpoints,
          }
        : {
            cmd: 'preload',
          };
    this.worker?.postMessage(JSON.stringify(msg));
    this.isRunning = true;
    this.handleTimeout();
  }

  /**
   * Send input to 'input()' function
   * @param str input of the user
   */
  submitInput(str: string) {
    if (this.worker && !this.isRunning) {
      const msg = { cmd: 'submit', str: str };
      this.worker.postMessage(JSON.stringify(msg));
      this.isRunning = true;
      this.handleTimeout();
    }
  }

  /**
   * Cancel input request from python
   */
  cancelInput() {
    if (this.worker && !this.isRunning) {
      const msg = {
        cmd: 'cancel',
      };
      this.worker.postMessage(JSON.stringify(msg));
      this.webworkerStatus = '';
      this.onStatusChanged && this.onStatusChanged('');
    }
  }

  dbgResume(dbgCmd: string) {
    if (this.worker && this.isSuspended) {
      const msg = {
        cmd: 'debug',
        dbg: dbgCmd,
      };
      this.worker.postMessage(JSON.stringify(msg));
      this.isRunning = true;
      this.handleTimeout();
    }
  }

  getFile(path: string) {
    const msg = { cmd: 'get', path: path };
    this.worker?.postMessage(JSON.stringify(msg));
  }

  putFile(path: string, data: string) {
    const msg = { cmd: 'put', path: path, data: data };
    this.worker?.postMessage(JSON.stringify(msg));
  }

  preload() {
    this.run(null);
  }

  clearOutput() {
    if (!this.sharedOutput) {
      this.outputBuffer = '';
    }
    this.onOutput && this.onOutput('', false);
  }

  clearFigure() {
    const msg = { cmd: 'clearFigure' };
    this.worker?.postMessage(JSON.stringify(msg));
  }

  printToOutput(str: string) {
    if (this.sharedOutput) {
      this.onOutput && this.onOutput(str, true);
    } else {
      this.outputBuffer += str;
      this.onOutput && this.onOutput(this.outputBuffer, false);
    }
  }

  private onStatusChanged(status: string) {
    let newStatus = PyodideStatus.UNKNOWN_STATUS;
    // loading Pyodide || loading module
    if (status.startsWith('loading Pyodide')) {
      newStatus = PyodideStatus.LOADING_PYODIDE;
    } else if (status.startsWith('pre-loading')) {
      newStatus = PyodideStatus.PRE_LOADING_MODULE;
    } else if (status.startsWith('error pre-loading')) {
      newStatus = PyodideStatus.PRE_LOADING_MODULE_ERROR;
    } else if (status.startsWith('loading module')) {
      newStatus = PyodideStatus.LOADING_MODULE;
    } else if (['startup', 'setup'].includes(status)) {
      newStatus = PyodideStatus.INSTALLING;
    } else if (status === 'running') {
      newStatus = PyodideStatus.RUNNING;
    } else if (['done', ''].includes(status)) {
      newStatus = PyodideStatus.READY;
    } else if (['timeout'].includes(status)) {
      newStatus = PyodideStatus.TIMEOUT;
    } else if (status === 'input') {
      newStatus = PyodideStatus.WAIT_INPUT;
    } else {
      newStatus = PyodideStatus.UNKNOWN_STATUS;
    }
    if (this.onStatusUpdate) {
      // call the user-defined callback with the enum status
      this.onStatusUpdate?.(newStatus);
    } else {
      console.log(`Status Update: ${newStatus}`);
    }
  }
}

export default PyWorker;
