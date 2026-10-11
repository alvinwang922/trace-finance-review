import { createClientFromRequest } from 'npm:@base44/sdk';
import { secrets } from 'base44:runtime';
import { handleResearch, type ResearchRequest } from './brightdata.ts';

/**
 * Public-web research for World context. Signed-in users only, so anonymous visitors
 * cannot spend the team's Bright Data credits. Reads only public pages about merchants,
 * processors and incidents; it never receives employee or card data.
 */
export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me().catch(() => null);
  if (!user) return Response.json({ error: 'Sign in to run public-web research.' }, { status: 401 });

  const token = secrets.get('BRIGHTDATA_API_KEY');
  if (!token) return Response.json({ error: 'BRIGHTDATA_API_KEY is not set for this app.' }, { status: 503 });

  let request: ResearchRequest;
  try {
    request = await req.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }
  try {
    return Response.json(await handleResearch(token, request));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Research failed.' }, { status: 502 });
  }
}
