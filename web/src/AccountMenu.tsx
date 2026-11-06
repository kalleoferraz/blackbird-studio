import type { Me } from './types.ts';
import { MenuButton, type MenuItem } from './ui.tsx';

/** The account items every menu ends with. */
export const accountItems = (onAccount: () => void, onLogout: () => void): MenuItem[] => [
  { label: 'Account settings', onClick: onAccount },
  { label: 'Sign out', onClick: onLogout },
];

/** The signed-in person's name, with a menu: account settings (password) and sign out. */
export function AccountMenu({ me, onAccount, onLogout }: { me: Me; onAccount: () => void; onLogout: () => void }) {
  return <MenuButton className="acct-btn" title="Account" items={accountItems(onAccount, onLogout)}>{me.user.displayName} ▾</MenuButton>;
}
