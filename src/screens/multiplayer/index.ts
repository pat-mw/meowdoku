/**
 * The in-match screens, as one import.
 *
 * A single entry point so the route's lazy chunk has one edge into this folder
 * rather than three. Which screen is on is decided by `RoomPhase`:
 *
 *   countdown, playing  -> MatchScreen      (it draws its own three-two-one)
 *   interlude           -> InterludeScreen
 *   finished            -> PodiumScreen
 *
 * `lobby` belongs to the lobby screen and is deliberately not handled here.
 */

export { MatchScreen, type MatchScreenProps } from './MatchScreen'
export { InterludeScreen } from './InterludeScreen'
export { PodiumScreen, type PodiumScreenProps } from './PodiumScreen'
