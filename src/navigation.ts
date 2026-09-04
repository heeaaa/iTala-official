import { NativeStackScreenProps } from '@react-navigation/native-stack';

export type RootStackParams = {
  Leagues: undefined;
  Settings: undefined;
  CreateLeague: { code?: string } | undefined;
  RecGame: undefined;
  LeagueDetail: { leagueId: string };
  GamesOnDate: { leagueId: string; dayKey: string; teamId?: string };
  ManageRoster: { leagueId: string };
  EditTeam: { leagueId: string; teamId: string };
  TeamProfile: { leagueId: string; teamId: string };
  NewGame: { leagueId: string };
  // `pending` carries a game that has NOT been created yet: the lineup screen
  // creates it when Tip off is pressed. Absent for the drop-in flow, where
  // REC_SETUP_GAME has already made the row in one transaction with its teams.
  SelectLineup: { leagueId: string; gameId: string; pending?: { homeTeamId: string; awayTeamId: string; location?: string } };
  LiveGame: { leagueId: string; gameId: string; spectator?: boolean };
  BoxScore: { leagueId: string; gameId: string };
  FinalScore: { leagueId: string; gameId: string };
  SeasonRecap: { leagueId: string };
  ShareCard:
    | { leagueId: string; kind: 'game'; gameId: string; playerId: string }
    | { leagueId: string; kind: 'season' }
    | { leagueId: string; kind: 'averages'; playerId: string };
  ManagePromos: undefined;
  BulkImport: { leagueId: string };
  PlayerProfile: { leagueId: string; playerId: string };
};

export type ScreenProps<T extends keyof RootStackParams> = NativeStackScreenProps<RootStackParams, T>;
