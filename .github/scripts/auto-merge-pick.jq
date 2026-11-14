# Picks the one pull request auto-merge.yml may merge, from
# `gh pr list --json number,headRefOid,isDraft,isCrossRepository,author,headRepositoryOwner`.
# A pull request merges itself only when it is ready (not a draft), its head is
# exactly the commit CI passed, its branch lives in this repository (never a
# fork), and its author is Krish or the Actions bot. Anything else is left for a
# person. Arguments: --arg sha <head sha> --arg owner <repository owner>.
# Tested by this repository's auto-merge guard test.
def allowed_author: (.author.login // "") as $a
  | ($a == "krishanraja" or $a == "github-actions" or $a == "app/github-actions" or $a == "github-actions[bot]");
[ .[]
  | select(.isDraft | not)
  | select(.headRefOid == $sha)
  | select(.isCrossRepository == false)
  | select((.headRepositoryOwner.login // "") == $owner)
  | select(allowed_author)
][0].number // empty
