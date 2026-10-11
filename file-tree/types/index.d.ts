/** A file Claude wrote or edited this session: an absolute path with '/' separators. */
export type Changed = { path: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'file-tree': {
      /** Folders the person has opened, absolute paths with '/' separators. */
      expanded: string[]
      /** Files touched by Write, Edit or NotebookEdit, newest last. */
      changed: Changed[]
      /** How many folders above the working folder the tree's root sits; 0 is the working folder. */
      up: number
      /** Bumped after anything that may have changed the disk; the drawing reads it to redraw. */
      rev: number
    }
  }
}
