/** Bumped on each poll that changed the run, so the pane redraws. */
export type PiReviewTick = number

declare module 'claude-code' {
  interface PluginState {
    'pi-review': { tick: PiReviewTick }
  }
}
