/**
 * File: pages/onboarding/team-invite.tsx
 * Description: Onboarding Step 3 - Allows Admin to invite initial team members.
 */

import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { useSession, signIn } from 'next-auth/react';
import { GetServerSideProps } from 'next';

interface TeamMember {
  email: string;
  role: 'STAFF' | 'MECHANIC';
}

const initialTeam: TeamMember[] = [
  { email: '', role: 'MECHANIC' } // Start with one blank input
];

const inputClass = "w-full p-3 bg-slate-700 border border-slate-600 rounded-lg text-white focus:ring-blue-500 transition";
const labelClass = "block text-sm font-medium text-slate-300 mb-1";
const panelClass = "bg-slate-700/50 p-4 rounded-xl border border-slate-700";

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
  if (status === 'loading') return <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">Loading...</div>;
  if (status === 'unauthenticated') {
    signIn('credentials', { callbackUrl: '/onboarding/team-invite' });
    return null;
  }
  
  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 sm:p-8">
      <Head>
        <title>Setup Team - GreaseDesk</title>
      </Head>

      <div className="max-w-xl mx-auto bg-slate-800 p-6 sm:p-8 rounded-xl shadow-2xl border border-blue-600/50">
        <h1 className="text-3xl font-bold mb-2 text-blue-400">Step 3: Team Setup</h1>
        <p className="text-slate-400 mb-6">
          Invite the mechanics and managers for your new site. They will receive a link to set their password.
        </p>

        {error && (
          <div className="bg-red-800 text-red-100 p-3 rounded-lg mb-4 text-sm">{error}</div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 mb-6">
            {teamMembers.map((member, index) => (
              <div key={index} className="flex gap-4 items-end">
                {/* Email Input */}
                <div className="flex-1">
                  <label htmlFor={`email-${index}`} className={labelClass}>Email Address</label>
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
                
                {/* Role Selector */}
                <div className="w-32">
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
                
                {/* Remove Button */}
                <button
                  type="button"
                  onClick={() => removeMember(index)}
                  className="bg-red-600 hover:bg-red-700 text-white p-3 rounded-lg w-10 h-10 flex items-center justify-center transition"
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
            className="text-blue-400 hover:text-blue-300 transition mb-6 flex items-center"
          >
            + Add Another Team Member
          </button>
          
          <hr className="border-slate-700 mb-6" />

          <div className="flex justify-between gap-4">
            <button
                type="button"
                onClick={() => router.push('/admin/dashboard')} // Allow skipping to the dashboard
                className="py-3 px-6 text-slate-400 hover:text-slate-300 transition"
                disabled={isSending}
            >
                Skip for now
            </button>
            <button
              type="submit"
              disabled={isSending}
              className="py-3 px-8 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-lg transition disabled:opacity-50"
            >
              {isSending ? 'Sending Invites...' : 'Send Invites & Go to Dashboard'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export const getServerSideProps: GetServerSideProps = async () => {
    return { props: {} };
}