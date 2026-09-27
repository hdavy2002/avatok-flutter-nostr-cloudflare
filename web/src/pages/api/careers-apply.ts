import type { APIRoute } from 'astro';

// [WEB-CAREERS-GONE-1 2026-09-27] The careers form is DELETED (see
// pages/careers.astro). This endpoint used to email every submission to
// support@saathum.com plus an acknowledgement to any typed-in address, with only
// a honeypot in front of it — bots were posting to it directly. It now refuses
// everything and sends NO mail. Kept as a file only so the URL answers 410
// instead of falling through to another route.
export const prerender = false;

const gone = () =>
  new Response(JSON.stringify({ ok: false, error: 'Applications are closed.' }), {
    status: 410,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });

export const GET: APIRoute = gone;
export const POST: APIRoute = gone;
export const ALL: APIRoute = gone;
