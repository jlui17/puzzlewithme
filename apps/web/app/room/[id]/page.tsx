import { RoomClient } from "../../../src/room/RoomClient";

/**
 * Thin server shell: resolve the room id from the route and hand off to the
 * client. All room data (existence, settings, live state) is fetched client-side
 * so this page renders without contacting the game server, and an unknown id
 * still returns 200 HTML with the client's "room not found" state.
 */
export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RoomClient roomId={id} />;
}
