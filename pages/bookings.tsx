/**
 * File: pages/bookings.tsx
 * Last edited: 2025-10-27 21:25 Europe/London
 *
 * Bookings list = today's jobs for the garage.
 * For now we fetch static mock data from /api/bookings.
 */
import useSWR from "swr";
import Layout from "../components/Layout";

interface BookingRow {
  id: string;
  time: string;
  reg: string;
  vehicle: string;
  service: string;
  status: string;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function BookingsPage() {
  const { data, error } = useSWR<BookingRow[]>("/api/bookings", fetcher);

  return (
    <Layout title="Today’s Bookings">
      <div className="p-4">
        <div className="rounded-2xl border border-gdBorder bg-gdPanel/60 shadow-card overflow-hidden">
          <table className="w-full text-left text-sm text-gdText">
            <thead className="bg-slate-800/60 text-xs uppercase text-gdSubtext">
              <tr>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Reg</th>
                <th className="px-4 py-3">Vehicle</th>
                <th className="px-4 py-3">Service</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {error && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-red-400 text-sm"
                  >
                    Failed to load.
                  </td>
                </tr>
              )}

              {!error &&
                data &&
                data.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t border-gdBorder/60 hover:bg-slate-800/30 cursor-pointer"
                  >
                    <td className="px-4 py-3">{row.time}</td>
                    <td className="px-4 py-3 font-semibold">{row.reg}</td>
                    <td className="px-4 py-3">{row.vehicle}</td>
                    <td className="px-4 py-3">{row.service}</td>
                    <td className="px-4 py-3">{row.status}</td>
                  </tr>
                ))}

              {!error && !data && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-gdSubtext text-sm"
                  >
                    Loading…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
