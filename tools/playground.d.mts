export interface HarnessConfig {
  site_url: string;
  username: string;
  app_password: string;
  pages: { about: number; treatments: number; post: number };
}

export declare const HARNESS_PORT: number;

export declare function startWordPress(opts?: { quiet?: boolean; port?: number }): Promise<{
  baseUrl: string;
  harness: HarnessConfig;
  stop: () => void;
}>;
