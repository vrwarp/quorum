import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Room } from '@quorum/shared';
import * as api from './api';
import { navigate, roomPath } from './router';
import { SettingsLink } from './SettingsScreen';

export function RoomsScreen() {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listRooms()
      .then(setRooms)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load rooms'));
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    try {
      const room = await api.createRoom(name.trim());
      navigate(roomPath(room.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create room');
    }
  }

  return (
    <div className="rooms-screen">
      <div className="screen-head">
        <h1>Rooms</h1>
        <span className="spacer" />
        <SettingsLink />
      </div>
      <form className="inline-form" onSubmit={create}>
        <input
          data-testid="room-create-name"
          aria-label="New room name"
          placeholder="New room name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="btn primary"
          data-testid="room-create-submit"
          type="submit"
          disabled={!name.trim()}
        >
          Create room
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {rooms === null ? (
        <p className="muted">Loading…</p>
      ) : rooms.length === 0 ? (
        <p className="muted">No rooms yet. Create one above.</p>
      ) : (
        <ul className="room-list">
          {rooms
            .filter((r) => !r.archivedAt)
            .map((r) => (
              <li key={r.id}>
                <a
                  data-testid={`room-link-${r.id}`}
                  href={roomPath(r.id)}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    navigate(roomPath(r.id));
                  }}
                >
                  {r.name}
                </a>
                <span className="muted small-text">
                  {' '}
                  {new Date(r.createdAt).toLocaleDateString()}
                </span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
