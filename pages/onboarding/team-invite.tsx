/**
 * File: pages/onboarding/team-invite.tsx
 * Description: Allows Admin to invite initial team members. NOT a gated wizard step — it is not
 * in ONBOARDING_ORDER, and numbering it invented a position it has never held.
 */

import { useState } from 'react';
import { useRouter } from 'next/router';
import { useSession, signIn } from 'next-auth/react';
import OnboardingLayout, { fieldClass, primaryButtonClass } from '@/components/layout/OnboardingLayout';
import { GetServerSideProps } from 'next';

interface TeamMember {
  email: string;
  role: 'STAFF' | 'MECHANIC';
}

const initialTeam: TeamMember[] = [
  { email: '', role: 'MECHANIC' } // Start with one blank input
];

const inputClass = fieldClass;
const labelClass = "block text-sm font-medium text-ink mb-1";

export default function TeamInvitePage() {
  const router = useRouter();
  const { status } = useSession();
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>(initialTeam);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleMemberChange = (index: number, field: keyof TeamMember, value: string) => {
    const newTeam = [...teamMembers];
    newTeam[index] = { ...newTeam[index], [field]: value };
    setTeamMembers(newTeam);
  };

  const addMember = () => {
    setTeamMembers([...teamMembers, { email: '', role: 'MECHANIC' }]);
  };

  const removeMember = (index: number) => {
    const newTeam = teamMembers.filter((_, i) => i !== index);
    setTeamMembers(newTeam.length > 0 ? newTeam : [{ email: '', role: 'MECHANIC' }]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSending(true);
    setError(null);
    
    const validMembers = teamMembers.filter(m => m.email && m.role);

    if (validMembers.length === 0) {
        // If the admin skipped this, we proceed to the dashboard
        router.push('/admin/dashboard');
        return;
    }

    try {
      const res = await fetch('/api/onboarding/invite-team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invites: validMembers }),
      });

      const result = await res.json();

      if (!res.ok || result.error) {
        throw new Error(result.message || "Failed to send invitations. Please check details.");
      }

      // Success: Redirect to the final dashboard
      router.push('/admin/dashboard'); 

    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSending(false);
    }
  };

  // Security Check
  if (status === 'loading') return <div className="min-h-screen bg-content flex items-center justify-center text-muted">Loading…</div>;
  if (status === 'unauthenticated') {
    signIn('credentials', { callbackUrl: '/onboarding/team-invite' });
    return null;
  }

  return (
    // NO step= : team-invite is not in ONBOARDING_ORDER, so it gets no "Step N of 6". It used to
    // call itself "Step 3", which was both a duplicate of the tax step and a claim to a position in
    // a wizard it has never been part of.
    <OnboardingLayout
      title="Invite your team"
      heading="Invite your team"
      intro="Invite the mechanics and managers for your new site. They will receive a link to set their password."
      width="lg"
    >
      {error && <div className="bg-danger-soft text-danger p-3 rounded-lg mb-4 text-sm" data-testid="invite-error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="space-y-4 mb-6">
          {teamMembers.map((member, index) => (
            <div key={index} className="flex gap-4 items-end">
              <div className="flex-1">
                <label htmlFor={`email-${index}`} className={labelClass}>Email address</label>
                <input
                  type="email"
                  id={`email-${index}`}
                  value={member.email}
                  onChange={(e) => handleMemberChange(index, 'email', e.target.value)}
                  className={inputClass}
                  placeholder="teammate@example.com"
                  disabled={isSending}
                />
              </div>

              <div className="w-36">
                <label htmlFor={`role-${index}`} className={labelClass}>Role</label>
                <select
                  id={`role-${index}`}
                  value={member.role}
                  onChange={(e) => handleMemberChange(index, 'role', e.target.value as 'STAFF' | 'MECHANIC')}
                  className={inputClass}
                  disabled={isSending}
                >
                  <option value="MECHANIC">Mechanic</option>
                  <option value="STAFF">Manager/Staff</option>
                </select>
              </div>

              {/* REMOVING A ROW IS NOT A DESTRUCTIVE ACT — nothing has been sent yet, so a red
                  button overstated it. A quiet control that turns danger-coloured on hover. */}
              <button
                type="button"
                onClick={() => removeMember(index)}
                className="border border-line text-muted hover:text-danger hover:border-danger rounded-lg w-11 h-11 flex items-center justify-center transition-colors disabled:opacity-40"
                aria-label="Remove member"
                disabled={teamMembers.length === 1 && teamMembers[0].email === ''}
              >
                −
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={addMember}
          className="text-sm text-accent hover:text-accent-hover font-medium mb-6"
        >
          + Add another team member
        </button>

        <hr className="border-line mb-6" />

        <div className="flex justify-between gap-4 items-center">
          <button
            type="button"
            onClick={() => router.push('/admin/dashboard')}
            className="text-sm text-muted hover:text-ink underline underline-offset-2"
            disabled={isSending}
          >
            Skip for now
          </button>
          <button type="submit" disabled={isSending} className={`${primaryButtonClass} w-auto px-8`}>
            {isSending ? 'Sending invites…' : 'Send invites & go to dashboard'}
          </button>
        </div>
      </form>
    </OnboardingLayout>
  );
}

export const getServerSideProps: GetServerSideProps = async () => {
    return { props: {} };
}