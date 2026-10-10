import { useCallback, useState, type ReactNode } from 'react';
import { ChevronDown, Hash, KeyRound, LogOut, Send, Unplug, type LucideIcon } from 'lucide-react';
import { useLogout, useMe } from '../../lib/auth';
import { useAccount } from '../../lib/account';
import { SLACK_INSTALL_URL, useSlackDisconnect, useSlackStatus, useSlackTest } from '../../lib/slack';
import { useDismiss } from '../../lib/useDismiss';
import { ApiError } from '../../lib/api';
import { Avatar } from '../Avatar';
import { ConfirmDialog } from '../ConfirmDialog';
import { useToast } from '../Toast';
import { SetPasswordModal } from '../account/SetPasswordModal';

export function UserMenu() {
  const { data: user } = useMe();
  const logout = useLogout();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const closePassword = useCallback(() => setPasswordOpen(false), []);
  const ref = useDismiss(open, close);

  const slack = useSlackStatus(open || confirmDisconnect);
  const account = useAccount(open);
  const test = useSlackTest();
  const disconnect = useSlackDisconnect();

  if (!user) return null;

  // Like any menu item, the menu closes on click; the toast reports the result.
  const sendTest = () => { setOpen(false); test.mutate(undefined, {
    onSuccess: () => toast.success(`Test message sent to ${slack.data?.channelName ?? 'Slack'}.`),
    onError: (err) => {
      toast.error(err instanceof ApiError && err.code === 'SLACK_NOT_CONNECTED'
        ? 'Slack is no longer connected. Please reconnect it.'
        : 'Couldn’t reach Slack. Please try again.');
      void slack.refetch();
    },
  }); };

  const doDisconnect = () => disconnect.mutate(undefined, {
    onSuccess: () => { setConfirmDisconnect(false); toast.success('Slack disconnected.'); },
    onError: () => { setConfirmDisconnect(false); toast.error('Couldn’t disconnect Slack. Please try again.'); },
  });

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-[58px] w-full items-center gap-2.5 rounded-lg bg-field px-3.5 text-left transition-colors hover:bg-gray-100"
      >
        <Avatar name={user.name} url={user.avatarUrl} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-gray-900">{user.name}</span>
          <span className="block truncate text-[11px] text-gray-500">{user.email}</span>
        </span>
        <ChevronDown className={`size-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div role="menu" aria-label="Account" className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg border border-line bg-white p-1 shadow-lg">
          {/* ── Slack ── */}
          <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-gray-400 uppercase">Slack</p>
          {slack.isPending ? (
            <p className="px-2.5 py-2 text-sm text-gray-400">Loading…</p>
          ) : slack.data?.connected ? (
            <>
              <div className="flex items-center gap-2.5 px-2.5 py-1.5" aria-label="Slack connection">
                <SlackMark />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-gray-900">{slack.data.teamName}</span>
                  <span className="block truncate text-[11px] text-gray-500">{slack.data.channelName} · connected</span>
                </span>
              </div>
              <Item icon={Send} onClick={sendTest} disabled={test.isPending}>
                {test.isPending ? 'Sending…' : 'Send test message'}
              </Item>
              <Item icon={Unplug} onClick={() => { setOpen(false); setConfirmDisconnect(true); }}>Disconnect Slack</Item>
            </>
          ) : slack.data?.enabled ? (
            <>
              {slack.data.status === 'REVOKED' && (
                <p className="px-2.5 pb-1 text-[11px] text-amber-700">Slack access was revoked. Reconnect to get alerts.</p>
              )}
              <Item icon={Hash} onClick={() => window.location.assign(SLACK_INSTALL_URL)}>
                {slack.data.status === 'REVOKED' ? 'Reconnect Slack' : 'Connect Slack'}
              </Item>
            </>
          ) : (
            <Item icon={Hash} disabled title="Slack isn't configured on this server (SLACK_* settings)">
              Connect Slack
              <span className="block text-[11px] text-gray-400">Not configured on this server</span>
            </Item>
          )}

          <div className="my-1 h-px bg-line" />
          <Item icon={KeyRound} onClick={() => { setOpen(false); setPasswordOpen(true); }}>
            {!account.data ? 'Password' : account.data.hasPassword ? 'Change password' : 'Set password'}
          </Item>
          <div className="my-1 h-px bg-line" />
          <Item icon={LogOut} onClick={() => logout.mutate()} disabled={logout.isPending}>
            {logout.isPending ? 'Logging out…' : 'Log out'}
          </Item>
        </div>
      )}

      <SetPasswordModal open={passwordOpen} onClose={closePassword} />
      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect Slack?"
        confirmLabel="Disconnect"
        cancelLabel="Cancel"
        busy={disconnect.isPending}
        onConfirm={doDisconnect}
        onCancel={() => setConfirmDisconnect(false)}
      >
        Rate-limit alerts will stop posting to{' '}
        <span className="font-medium text-gray-900">{slack.data?.channelName ?? 'your channel'}</span>
        {slack.data?.teamName ? <> in {slack.data.teamName}</> : null}. You can reconnect any time.
      </ConfirmDialog>
    </div>
  );
}

function Item({ icon: Icon, children, onClick, disabled, title }: {
  icon: LucideIcon;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm text-gray-700 hover:bg-field disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </button>
  );
}

/** Slack's aubergine with a channel "#": recognisable without reproducing the logo. */
function SlackMark() {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[#4a154b] text-white" aria-hidden="true">
      <Hash className="size-4" strokeWidth={2.5} />
    </span>
  );
}
