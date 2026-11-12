// The wallet list handed to @hot-labs/near-connect. Passing it inline stops the library from fetching its
// default manifest from a moving branch on GitHub, and every executor URL below is pinned to a commit, so the
// wallet code that runs in the sandbox only changes when this file changes. server/csp.ts allows exactly
// these executor URLs, so adding a wallet here also needs its origins added there (tests/server/csp.test.ts
// checks the executors).
//
// Only HOT and Meteor are listed: both sign NEP-413 messages and send transactions on mainnet without a page
// redirect, which is what sign-in and intents.near key registration need.
//
// To update a wallet: read the new executor at its new commit, then replace the commit hash and `version`.

const METEOR_ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 400.04 400.04"><defs>` +
  `<linearGradient id="a" x1="215.39" y1="239.47" x2="382.38" y2="239.47" gradientTransform="translate(-122.96 -148.16)" gradientUnits="userSpaceOnUse"><stop offset=".07" stop-color="#0f0f36"/><stop offset=".76" stop-color="#232371"/></linearGradient>` +
  `<linearGradient id="b" x1="285.49" y1="335.04" x2="469.44" y2="335.04" gradientTransform="translate(-78.4 -231.71)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0f0f36"/><stop offset=".8" stop-color="#232371"/></linearGradient>` +
  `<linearGradient id="c" x1="298.99" y1="428.49" x2="366.74" y2="428.49" gradientTransform="translate(.74 -227.54)" xlink:href="#a"/>` +
  `<linearGradient id="d" x1="36.6" y1="332.92" x2="431.62" y2="332.92" gradientTransform="rotate(-45 58.56 313.83)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#479ff5"/><stop offset=".22" stop-color="#405ee5"/><stop offset=".35" stop-color="#523bda"/><stop offset=".43" stop-color="#5a55ce"/><stop offset=".56" stop-color="#5a55ce"/><stop offset=".76" stop-color="#3b3cbb"/><stop offset=".87" stop-color="#171e9b"/><stop offset="1" stop-color="#171e9b"/></linearGradient></defs>` +
  `<path d="M105 65.29h128.39a26 26 0 0 1 26 26 26 26 0 0 1-26 26H105a12.54 12.54 0 0 1-12.57-12.49v-27A12.54 12.54 0 0 1 105 65.29Z" transform="rotate(-45 175.92 91.31)" fill="url(#a)"/>` +
  `<path d="M220.2 76.74h144.24A26.59 26.59 0 0 1 391 103.33a26.59 26.59 0 0 1-26.59 26.59H220.2a13.11 13.11 0 0 1-13.11-13.11v-27a13.11 13.11 0 0 1 13.11-13.07Z" transform="rotate(-45 299.06 103.33)" fill="url(#b)"/>` +
  `<rect x="299.73" y="176.9" width="67.75" height="48.08" rx="24.04" transform="rotate(-45 333.6 200.95)" fill="url(#c)"/>` +
  `<path d="m339.09 99.35-64.8 64.8a25.5 25.5 0 0 1-36.05 0 25.49 25.49 0 0 1 0-36L252 114.37c8.68-8.69 9.33-22.93.81-31.77a22.3 22.3 0 0 0-31.81-.29l-60.82 60.83a25.49 25.49 0 0 1-36 0 25.5 25.5 0 0 1 0-36.06l20.26-20.27a22.31 22.31 0 0 0-.3-31.83c-8.84-8.52-23.08-7.86-31.76.82l-55 55c-.26.25-.48.53-.72.79A163.53 163.53 0 0 0 287.8 342.86l-.2-.2c.26-.24.53-.46.79-.72l97.09-97.09c8.68-8.68 9.34-22.92.81-31.76a22.31 22.31 0 0 0-31.83-.3s18.18-18.15-9.8 9.86a23.25 23.25 0 0 1-32.9 0 23.25 23.25 0 0 1 0-32.9l59.39-59.39a22.31 22.31 0 0 0-.3-31.83c-8.85-8.53-23.08-7.86-31.76.82Z" fill="url(#d)"/>` +
  `<rect x="62.59" y="94.34" width="50.97" height="25.49" rx="12.74" transform="rotate(-45 88.07 107.1)" fill="#a4a1ef"/><circle cx="124.11" cy="71.04" r="12.74" fill="#c2bffc"/>` +
  `<rect x="208.62" y="89.84" width="38.23" height="25.49" rx="12.74" transform="rotate(-45 227.74 102.58)" fill="#786bee"/></svg>`;

/** The subset of near-connect's WalletManifest this app fills in; kept structural so server code needs no import. */
export type PinnedWalletManifest = {
  id: string;
  name: string;
  icon: string;
  description: string;
  website: string;
  version: string;
  executor: string;
  type: "sandbox";
  platform: Record<string, string>;
  features: Record<string, boolean>;
  permissions: { storage?: boolean; allowsOpen?: string[]; external?: string[] };
};

export const NEAR_CONNECT_WALLETS: PinnedWalletManifest[] = [
  {
    id: "hot-wallet",
    name: "HOT Wallet",
    // HOT's executor already loads this exact image from storage.herewallet.app, so the icon adds no origin.
    icon: "https://storage.herewallet.app/upload/3390b7e4e15fed4122572898712bdf4c6ede862e36150203deecacc4f8bbe5ae.png",
    description: "Secure Multichain wallet. Manage assets, refuel gas, and mine $HOT on any device with HOT Wallet",
    website: "https://hot-labs.org/wallet",
    version: "1.0.4",
    executor: "https://raw.githubusercontent.com/hot-dao/near-selector/b8207d0b303914f264c50be5ac849d5fe028f069/repository/hotwallet.js",
    type: "sandbox",
    platform: {
      android: "https://play.google.com/store/apps/details?id=app.herewallet.hot&hl=en",
      ios: "https://apps.apple.com/us/app/hot-wallet/id6740916148",
      chrome: "https://chromewebstore.google.com/detail/hot-wallet/mpeengabcnhhjjgleiodimegnkpcenbk",
      firefox: "https://addons.mozilla.org/en-US/firefox/addon/hot-wallet",
      tga: "https://t.me/hot_wallet/app",
    },
    features: {
      signMessage: true,
      signInWithoutAddKey: true,
      signAndSendTransaction: true,
      signAndSendTransactions: true,
      signInAndSignMessage: true,
      mainnet: true,
    },
    permissions: {
      storage: true,
      allowsOpen: [
        "https://download.hot-labs.org",
        "https://hot-labs.org/wallet",
        "https://t.me/hot_wallet/app",
        "https://app.hot-labs.org/link",
        "https://play.google.com",
        "https://apps.apple.com",
        "hotwallet://",
        "intent://",
      ],
      external: ["Telegram.WebApp", "TelegramWebviewProxy"],
    },
  },
  {
    id: "meteor-wallet",
    name: "Meteor Wallet",
    icon: `data:image/svg+xml,${encodeURIComponent(METEOR_ICON_SVG)}`,
    description: "The most simple and secure wallet to manage your crypto, access DeFi, and explore Web3",
    website: "https://meteorwallet.app/",
    version: "1.1.1",
    executor:
      "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/6369ad789d2f3aaf8e6ccb065021723111027174/storage/meteor-near-connect-latest.js",
    type: "sandbox",
    platform: {
      web: "https://wallet.meteorwallet.app",
      chrome: "https://chromewebstore.google.com/detail/meteor-wallet/pcndjhkinnkaohffealmlmhaepkpmgkb",
      android: "https://play.google.com/store/apps/details?id=app.meteorwallet.v2",
      ios: "https://apps.apple.com/us/app/meteor-wallet/id6739558223",
    },
    features: {
      signMessage: true,
      signInWithoutAddKey: true,
      signInAndSignMessage: true,
      signAndSendTransaction: true,
      signAndSendTransactions: true,
      mainnet: true,
    },
    permissions: {
      storage: true,
      allowsOpen: ["https://chromewebstore.google.com", "https://wallet.meteorwallet.app", "https://meteorwallet.app", "meteorwallet://"],
      external: ["meteorCom", "meteorComV2"],
    },
  },
];

/** NEAR RPC the sandboxed wallets are told to use (near-connect `providers.mainnet`). Must be in the CSP. */
export const NEAR_CONNECT_RPC = "https://free.rpc.fastnear.com";
