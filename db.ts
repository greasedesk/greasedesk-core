/**
 * File: lib/db.ts
 * Last edited: 2025-10-27 21:25 Europe/London
 *
 * Placeholder DB adapter.
 * Later this will connect to Neon/Supabase Postgres using DATABASE_URL.
 */
export async function getTodayBookingsMock(accountId: string) {
  // accountId lets us isolate each garage (multi-tenant)
  return [
    {
      id: "jc-1001",
      time: "08:30",
      reg: "BJ16 XYZ",
      vehicle: "BMW 520d",
      service: "Oil Service + Health Check",
      status: "booked"
    },
    {
      id: "jc-1002",
      time: "10:00",
      reg: "MF70 ABC",
      vehicle: "MINI F56 Cooper S",
      service: "Timing chain noise investigation",
      status: "in_progress"
    },
    {
      id: "jc-1003",
      time: "13:30",
      reg: "YK22 TMS",
      vehicle: "BMW X5 M50d",
      service: "Brake fluid flush",
      status: "completed"
    }
  ];
}

export async function getJobCardMock(jobCardId: string) {
  return {
    id: jobCardId,
    vehicle: "BMW 520d",
    reg: "BJ16 XYZ",
    technician: "Lewis",
    tasks: [
      {
        id: "t1",
        title: "Oil service – BMW 520d",
        notes:
          "Drain oil, replace filter, refill LL-04, reset service computer.",
        done: false
      },
      {
        id: "t2",
        title: "Brake fluid flush",
        notes: "Pressure bleed all four corners, torque check calipers.",
        done: false
      }
    ],
    intakeSlots: [
      "front",
      "left",
      "rear",
      "right",
      "engine_bay",
      "vin",
      "mileage"
    ]
  };
}
