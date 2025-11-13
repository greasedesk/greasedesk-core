/**
 * File: components/Header.tsx
 * Description: The main application header component, containing the logo and top navigation elements.
 */

import React from 'react';
import Link from 'next/link';

// Assuming you've placed the high-res logo at /public/greasedesk-logo-source.png
const LOGO_SRC = "/greasedesk-logo-source.png"; 

// Dimensions for the logo display (to scale the high-res source down sharply)
const LOGO_WIDTH = 180; 
const LOGO_HEIGHT = 40; 

// Component for the Logo Link
const Logo = () => (
  <Link href="/" className="flex items-center">
    <img
      src={LOGO_SRC}
      alt="GreaseDesk Logo"
      // Set the display size to 180x40 to ensure sharpness from the large source image
      style={{ width: `${LOGO_WIDTH}px`, height: `${LOGO_HEIGHT}px` }} 
    />
  </Link>
);


export default function Header() {
  return (
    // Outer wrapper for the header, using the dark navy background typical of your site
    <header className="bg-slate-900 border-b border-slate-700 sticky top-0 z-50">
      
      {/* Container to center and limit width, common Tailwind practice */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        <div className="flex justify-between items-center h-16">
          
          {/* Logo Area */}
          <div className="flex-shrink-0">
            <Logo />
          </div>

          {/* Navigation Links Area (Placeholder) */}
          <nav className="flex space-x-4">
            {/* You would place primary navigation links here (e.g., Bookings, Job Cards) */}
          </nav>

          {/* User/Action Buttons Area (Placeholder) */}
          <div className="flex items-center">
            {/* User profile, Sign In/Out, or Start Trial buttons will go here */}
            <span className="text-slate-400 text-sm">User Actions</span>
          </div>

        </div>
      </div>
    </header>
  );
}