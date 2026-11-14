Status: Each kit's site fix names the repository that ships its host, read from config/subjects.json host_repos (Vercel project domains, 14 November): krishraja.com ships in krish-raja, ctrl.mindmake.co in mindmake-ctrl (it named mindmake before), Cloudflare and Substack hosts in none, and a host with no entry in its product's repository (fleet integration I-10, AEO's half). The packet field is the existing kits[].site_fixes[].owner_repo, so the contract is unchanged.
Next: Control Center's get_ai_answers serves each host's fixes to the repository that ships it (lane C); the 22 November run is the first to carry them.
North Star check (2026-11-14): holds.
Changed: A site fix names the repository that ships its host, not only its product's.
