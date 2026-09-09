/*
 * The terminal's sixteen colours, drawn from the same palette as the rest.
 *
 * A shell that ships its own defaults is the fastest way to make an interface
 * look assembled from parts: the greens and reds arrive from a different
 * decade than everything around them. These are the interface's own semantic
 * colours, with the remaining hues chosen to sit at the same saturation.
 *
 * One of the two files in this repository allowed to hold raw colour literals —
 * xterm takes a JavaScript theme object and cannot read CSS variables — and it
 * is shared by the virtual and the container terminal so that the exception
 * stays one file rather than two that drift apart.
 */
export const TERMINAL_COLORS = {
  dark: {
    // Exactly --c-surface-sunken (7 9 11). It had drifted to #070909, which is
    // invisible but is the drift this whole block is exposed to: xterm needs
    // literals, so nothing checks these against the tokens they stand for.
    background: '#07090b',
    foreground: '#e3e7ed',
    cursor: '#38b0d6',
    selectionBackground: '#12384a',
    black: '#0b0d10',
    red: '#f07171',
    green: '#3dc782',
    yellow: '#e6b04a',
    blue: '#7fb2e8',
    magenta: '#c39ae0',
    cyan: '#38b0d6',
    white: '#e3e7ed',
    brightBlack: '#6d7581',
    brightRed: '#f79191',
    brightGreen: '#63d69b',
    brightYellow: '#f0c473',
    brightBlue: '#9ac6f0',
    brightMagenta: '#d4b4ea',
    brightCyan: '#68c8e6',
    brightWhite: '#ffffff',
  },
  light: {
    background: '#ffffff',
    foreground: '#15191f',
    cursor: '#0d749c',
    selectionBackground: '#dbf0f8',
    black: '#15191f',
    red: '#ba2828',
    green: '#0d7742',
    yellow: '#8d5c06',
    blue: '#1d5fb8',
    magenta: '#7c2d9e',
    cyan: '#0d749c',
    white: '#f6f7f9',
    brightBlack: '#555c67',
    brightRed: '#d63b3b',
    brightGreen: '#158f52',
    brightYellow: '#a56f0b',
    brightBlue: '#2a72d0',
    brightMagenta: '#9139b5',
    brightCyan: '#1189b5',
    brightWhite: '#ffffff',
  },
};
