export type RootStackParams = {
  Leagues: undefined;
  CreateLeague: undefined;
  ManageRoster: { leagueId: string };
  LeagueDetail: { leagueId: string };
  LeagueSettings: { leagueId: string };
  NewGame: { leagueId: string };
  SelectLineup: { leagueId: string; gameId: string };
  /**
   * `spectator` forces read-only. It is derived from the role by default;
   * v1 let the two disagree, which meant the screen's state and the user's
   * actual permission could diverge.
   */
  LiveGame: { leagueId: string; gameId: string; spectator?: boolean };
  BoxScore: { leagueId: string; gameId: string };
};
