// Every GraphQL document the Linear adapter sends, checked against Linear's public schema by the tests. Each
// query costs under Linear's 10,000-point cap per request, counted as Linear's docs count it: 0.1 per scalar,
// 1 per object, and each connection multiplies its children by its `first` or `last` (spec 1, "Polls").
// A test pins each cost.

/** Issues per page of the snapshot's issue query, at about 123 points each. */
export const ISSUE_PAGE = 50;
/** Sent issues per blocker query, at about 1,300 points each. */
export const BLOCKER_CHUNK = 5;
/** Comments per page. */
export const COMMENT_PAGE = 100;
/** Issues per batch when the adapter follows duplicate chains. */
export const ISSUE_BATCH = 50;

/** The fields a snapshot and `issue` share. */
const ISSUE_FIELDS = `
  id identifier title url priority createdAt archivedAt
  state { name type }
  assignee { id }
  parent { id }
  subscribers(first: 50) { nodes { id } }
  children(first: 50) { nodes { id } }
  stateHistory(last: 3) { nodes { startedAt endedAt } }`;

const COMMENT_FIELDS = `
  id body createdAt
  user { id }
  externalUser { id }
  syncedWith { service }
  parent { id }`;

export const TEAM = `query FlightDeckTeam($key: String!) {
  teams(first: 1, filter: { key: { eq: $key } }) {
    nodes { id key states(first: 100) { nodes { id name type } } }
  }
}`;

export const SNAPSHOT_ISSUES = `query FlightDeckSnapshot($filter: IssueFilter!, $after: String) {
  issues(first: ${ISSUE_PAGE}, after: $after, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ISSUE_FIELDS} }
  }
}`;

/**
 * For each sent issue: the issues that block it (`blocks` relations pointing at it), each with its `duplicate`
 * relations, and the issues it blocks, each with every issue that blocks that one.
 */
export const BLOCKERS = `query FlightDeckBlockers($ids: [ID!]!) {
  issues(first: ${BLOCKER_CHUNK}, filter: { id: { in: $ids } }) {
    nodes {
      id
      inverseRelations(first: 20) {
        nodes {
          type
          issue {
            id identifier title url
            state { name type }
            relations(first: 10) { nodes { type relatedIssue { id identifier } } }
          }
        }
      }
      relations(first: 20) {
        nodes {
          type
          relatedIssue {
            id
            state { type }
            inverseRelations(first: 10) { nodes { type issue { id state { type } } } }
          }
        }
      }
    }
  }
}`;

/** The issues a duplicate chain leads to, each with its own `duplicate` relations. */
export const DUPLICATE_LINKS = `query FlightDeckDuplicates($ids: [ID!]!) {
  issues(first: ${ISSUE_BATCH}, filter: { id: { in: $ids } }) {
    nodes {
      id identifier title url
      state { name type }
      relations(first: 10) { nodes { type relatedIssue { id identifier } } }
    }
  }
}`;

export const COMMENTS = `query FlightDeckComments($filter: CommentFilter!, $after: String) {
  comments(first: ${COMMENT_PAGE}, after: $after, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes { ${COMMENT_FIELDS} issue { id } }
  }
}`;

export const ISSUE = `query FlightDeckIssue($id: String!) {
  issue(id: $id) {
    ${ISSUE_FIELDS}
    description
    team { key }
    creator { id }
    syncedWith { service }
    attachments(first: 20) { nodes { id url sourceType } }
    comments(first: ${COMMENT_PAGE}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${COMMENT_FIELDS} }
    }
  }
}`;

export const ISSUE_COMMENTS = `query FlightDeckIssueComments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: ${COMMENT_PAGE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${COMMENT_FIELDS} }
    }
  }
}`;

/** What `post`, `clearFlag`, and `unsubscribe` read first: the assignee, and whether the maintainer is subscribed. */
export const FLAG_STATE = `query FlightDeckFlagState($id: String!, $user: ID!) {
  issue(id: $id) {
    id identifier
    assignee { id }
    subscribers(first: 1, filter: { id: { eq: $user } }) { nodes { id } }
  }
}`;

export const DESCRIPTION = `query FlightDeckDescription($id: String!) {
  issue(id: $id) { id description }
}`;

export const ISSUE_ID = `query FlightDeckIssueId($id: String!) {
  issue(id: $id) { id }
}`;

export const UPDATE = `mutation FlightDeckUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

export const UNSUBSCRIBE = `mutation FlightDeckUnsubscribe($id: String!, $user: String!) {
  issueUnsubscribe(id: $id, userId: $user) { success }
}`;

export const COMMENT = `mutation FlightDeckComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id createdAt } }
}`;

/**
 * The duplicate relation and the move to the `duplicate` role's status, in one request. Linear's schema has no
 * `issueUpdate` field for a duplicate, so the relation is its own mutation, run first.
 */
export const DUPLICATE = `mutation FlightDeckDuplicate($relation: IssueRelationCreateInput!, $id: String!, $input: IssueUpdateInput!) {
  relation: issueRelationCreate(input: $relation) { success }
  update: issueUpdate(id: $id, input: $input) { success }
}`;

export const CREATE = `mutation FlightDeckFile($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}`;

export const RELATE = `mutation FlightDeckRelate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success }
}`;

export const DETACH = `mutation FlightDeckDetach($attachment: String!) {
  issueExternalSyncDisable(attachmentId: $attachment) { success }
}`;

export const UPLOAD = `mutation FlightDeckUpload($contentType: String!, $filename: String!, $size: Int!) {
  fileUpload(contentType: $contentType, filename: $filename, size: $size) {
    success
    uploadFile { uploadUrl assetUrl headers { key value } }
  }
}`;
