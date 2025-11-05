/**
 * File: components/emails/VerificationEmail.tsx
 * Last edited: 2025-11-02 at 19:55..
 *
 * This is a React component for our verification email.
 * FIX: Corrected import typo 'Readt' to 'React'
 */

import * as React from 'react'; // <<< THIS LINE IS NOW FIXED

// Interface defines the props our component will receive
interface VerificationEmailProps {
  name: string;
  verificationLink: string;
}

// We use inline styles for maximum compatibility with email clients
const main = {
  backgroundColor: '#f6f9fc',
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
};

const container = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  padding: '20px 0 48px',
  marginBottom: '64px',
  border: '1px solid #f0f0f0',
  borderRadius: '4px',
};

const box = {
  padding: '0 48px',
};

const h1 = {
  color: '#333',
  fontSize: '24px',
  fontWeight: 'bold',
  textAlign: 'center' as const,
};

const text = {
  color: '#555',
  fontSize: '16px',
  lineHeight: '26px',
};

const btnContainer = {
  textAlign: 'center' as const,
  marginTop: '32px',
};

const button = {
  backgroundColor: '#3b82f6', // Vercel blue / Tailwind blue-500
  borderRadius: '6px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: 'bold',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  padding: '12px 20px',
};

const hr = {
  borderColor: '#e6ebf1',
  margin: '20px 0',
};

const footer = {
  color: '#999',
  fontSize: '12px',
  lineHeight: '22px',
};

export const VerificationEmail: React.FC<VerificationEmailProps> = ({
  name,
  verificationLink,
}) => (
  <div style={main}>
    <div style={container}>
      <div style={box}>
        <h1 style={h1}>Welcome to GreaseDesk!</h1>
        <p style={text}>Hi {name},</p>
        <p style={text}>
          Thank you for signing up. To start your 30-day free trial, please verify
          your email address by clicking the button below:
        </p>
        
        <div style={btnContainer}>
          <a style={button} href={verificationLink}>
            Verify Email Address
          </a>
        </div>
        
        <p style={text}>
          If the button doesn't work, you can also copy and paste this link
          into your browser:
        </p>
        <p style={text}>{verificationLink}</p>
        
        <hr style={hr} />
        
        <p style={footer}>
          GreaseDesk Ltd.
          You received this email because you signed up for a free trial.
        </p>
      </div>
    </div>
  </div>
);

export default VerificationEmail;