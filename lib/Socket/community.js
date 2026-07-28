"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeCommunitiesSocket = exports.extractCommunityMetadata = void 0;
const { proto } = require("../../WAProto");
const { WAMessageStubType, WAMessageAddressingMode } = require("../Types");
const { generateMessageID, unixTimestampSeconds } = require("../Utils");
const {
    getBinaryNodeChild,
    getBinaryNodeChildren,
    getBinaryNodeChildString,
    jidEncode,
    jidNormalizedUser,
} = require("../WABinary");
const { makeBusinessSocket } = require("./business");
const makeCommunitiesSocket = (config) => {
    const conn = makeBusinessSocket(config);
    const { authState, ev, query, groupMetadata, upsertMessage, cleanDirtyBits } = conn;
    const communityQuery = async (jid, type, content) => query({
        tag: 'iq',
        attrs: { type, xmlns: 'w:g2', to: jid },
        content
    });
    const communityMetadata = async (jid) => {
        const result = await communityQuery(jid, 'get', [
            { tag: 'query', attrs: { request: 'interactive' } }
        ]);
        return extractCommunityMetadata(result);
    };
    const communityFetchAllParticipating = async () => {
        const result = await query({
            tag: 'iq',
            attrs: { to: '@g.us', xmlns: 'w:g2', type: 'get' },
            content: [
                {
                    tag: 'participating',
                    attrs: {},
                    content: [
                        { tag: 'participants', attrs: {} },
                        { tag: 'description', attrs: {} }
                    ]
                }
            ]
        });
        const data = {};
        const communitiesChild = getBinaryNodeChild(result, 'communities');
        if (communitiesChild) {
            const communities = getBinaryNodeChildren(communitiesChild, 'community');
            for (const communityNode of communities) {
                const meta = extractCommunityMetadata({
                    tag: 'result',
                    attrs: {},
                    content: [communityNode]
                });
                data[meta.id] = meta;
            }
        }
        conn.ev.emit('groups.update', Object.values(data));
        return data;
    };
    async function parseGroupResult(node) {
        var _a;
        (_a = conn.logger) === null || _a === void 0 ? void 0 : _a.info({ node }, 'parseGroupResult');
        const groupNode = getBinaryNodeChild(node, 'group');
        if (groupNode) {
            try {
                const metadata = await groupMetadata(`${groupNode.attrs.id}@g.us`);
                return metadata || null;
            }
            catch (error) {
                var _b;
                (_b = conn.logger) === null || _b === void 0 ? void 0 : _b.warn({ error }, 'Error parsing group metadata');
                return null;
            }
        }
        return null;
    }
    conn.ws.on('CB:ib,,dirty', async (node) => {
        const { attrs } = getBinaryNodeChild(node, 'dirty');
        if (attrs.type !== 'communities') {
            return;
        }
        await communityFetchAllParticipating();
        await cleanDirtyBits('groups');
    });
    return {
        ...conn,
        communityQuery,
        communityMetadata,
        communityCreate: async (subject, body) => {
            const descriptionId = generateMessageID().substring(0, 12);
            const result = await communityQuery('@g.us', 'set', [
                {
                    tag: 'create',
                    attrs: { subject },
                    content: [
                        {
                            tag: 'description',
                            attrs: { id: descriptionId },
                            content: [
                                { tag: 'body', attrs: {}, content: Buffer.from(body || '', 'utf-8') }
                            ]
                        },
                        { tag: 'parent', attrs: { default_membership_approval_mode: 'request_required' } },
                        { tag: 'allow_non_admin_sub_group_creation', attrs: {} },
                        { tag: 'create_general_chat', attrs: {} }
                    ]
                }
            ]);
            return await parseGroupResult(result);
        },
        communityCreateGroup: async (subject, participants, parentCommunityJid) => {
            const key = generateMessageID();
            const result = await communityQuery('@g.us', 'set', [
                {
                    tag: 'create',
                    attrs: { subject, key },
                    content: [
                        ...participants.map((jid) => ({ tag: 'participant', attrs: { jid } })),
                        { tag: 'linked_parent', attrs: { jid: parentCommunityJid } }
                    ]
                }
            ]);
            return await parseGroupResult(result);
        },
        communityLeave: async (id) => {
            await communityQuery('@g.us', 'set', [
                { tag: 'leave', attrs: {}, content: [{ tag: 'community', attrs: { id } }] }
            ]);
        },
        communityUpdateSubject: async (jid, subject) => {
            await communityQuery(jid, 'set', [
                { tag: 'subject', attrs: {}, content: Buffer.from(subject, 'utf-8') }
            ]);
        },
        communityLinkGroup: async (groupJid, parentCommunityJid) => {
            await communityQuery(parentCommunityJid, 'set', [
                {
                    tag: 'links',
                    attrs: {},
                    content: [
                        {
                            tag: 'link',
                            attrs: { link_type: 'sub_group' },
                            content: [{ tag: 'group', attrs: { jid: groupJid } }]
                        }
                    ]
                }
            ]);
        },
        communityUnlinkGroup: async (groupJid, parentCommunityJid) => {
            await communityQuery(parentCommunityJid, 'set', [
                {
                    tag: 'unlink',
                    attrs: { unlink_type: 'sub_group' },
                    content: [{ tag: 'group', attrs: { jid: groupJid } }]
                }
            ]);
        },
        communityFetchLinkedGroups: async (jid) => {
            let communityJid = jid;
            let isCommunity = false;
            const metadata = await groupMetadata(jid);
            if (metadata.linkedParent) {
                communityJid = metadata.linkedParent;
            }
            else {
                isCommunity = true;
            }
            const result = await communityQuery(communityJid, 'get', [
                { tag: 'sub_groups', attrs: {} }
            ]);
            const linkedGroupsData = [];
            const subGroupsNode = getBinaryNodeChild(result, 'sub_groups');
            if (subGroupsNode) {
                const groupNodes = getBinaryNodeChildren(subGroupsNode, 'group');
                for (const groupNode of groupNodes) {
                    linkedGroupsData.push({
                        id: groupNode.attrs.id ? jidEncode(groupNode.attrs.id, 'g.us') : undefined,
                        subject: groupNode.attrs.subject || '',
                        creation: groupNode.attrs.creation ? Number(groupNode.attrs.creation) : undefined,
                        owner: groupNode.attrs.creator ? jidNormalizedUser(groupNode.attrs.creator) : undefined,
                        size: groupNode.attrs.size ? Number(groupNode.attrs.size) : undefined
                    });
                }
            }
            return { communityJid, isCommunity, linkedGroups: linkedGroupsData };
        },
        communityRequestParticipantsList: async (jid) => {
            const result = await communityQuery(jid, 'get', [
                { tag: 'membership_approval_requests', attrs: {} }
            ]);
            const node = getBinaryNodeChild(result, 'membership_approval_requests');
            const participants = getBinaryNodeChildren(node, 'membership_approval_request');
            return participants.map((v) => v.attrs);
        },
        communityRequestParticipantsUpdate: async (jid, participants, action) => {
            const result = await communityQuery(jid, 'set', [
                {
                    tag: 'membership_requests_action',
                    attrs: {},
                    content: [
                        {
                            tag: action,
                            attrs: {},
                            content: participants.map((jid) => ({ tag: 'participant', attrs: { jid } }))
                        }
                    ]
                }
            ]);
            const node = getBinaryNodeChild(result, 'membership_requests_action');
            const nodeAction = getBinaryNodeChild(node, action);
            const participantsAffected = getBinaryNodeChildren(nodeAction, 'participant');
            return participantsAffected.map((p) => ({ status: p.attrs.error || '200', jid: p.attrs.jid }));
        },
        communityParticipantsUpdate: async (jid, participants, action) => {
            const result = await communityQuery(jid, 'set', [
                {
                    tag: action,
                    attrs: action === 'remove' ? { linked_groups: 'true' } : {},
                    content: participants.map((jid) => ({ tag: 'participant', attrs: { jid } }))
                }
            ]);
            const node = getBinaryNodeChild(result, action);
            const participantsAffected = getBinaryNodeChildren(node, 'participant');
            return participantsAffected.map((p) => ({ status: p.attrs.error || '200', jid: p.attrs.jid, content: p }));
        },
        communityUpdateDescription: async (jid, description) => {
            var _a;
            const metadata = await communityMetadata(jid);
            const prev = (_a = metadata.descId) !== null && _a !== void 0 ? _a : null;
            await communityQuery(jid, 'set', [
                {
                    tag: 'description',
                    attrs: {
                        ...(description ? { id: generateMessageID() } : { delete: 'true' }),
                        ...(prev ? { prev } : {})
                    },
                    content: description
                        ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }]
                        : undefined
                }
            ]);
        },
        communityInviteCode: async (jid) => {
            var _a;
            const result = await communityQuery(jid, 'get', [{ tag: 'invite', attrs: {} }]);
            const inviteNode = getBinaryNodeChild(result, 'invite');
            return (_a = inviteNode === null || inviteNode === void 0 ? void 0 : inviteNode.attrs) === null || _a === void 0 ? void 0 : _a.code;
        },
        communityRevokeInvite: async (jid) => {
            var _a;
            const result = await communityQuery(jid, 'set', [{ tag: 'invite', attrs: {} }]);
            const inviteNode = getBinaryNodeChild(result, 'invite');
            return (_a = inviteNode === null || inviteNode === void 0 ? void 0 : inviteNode.attrs) === null || _a === void 0 ? void 0 : _a.code;
        },
        communityAcceptInvite: async (code) => {
            var _a;
            const results = await communityQuery('@g.us', 'set', [
                { tag: 'invite', attrs: { code } }
            ]);
            const result = getBinaryNodeChild(results, 'community');
            return (_a = result === null || result === void 0 ? void 0 : result.attrs) === null || _a === void 0 ? void 0 : _a.jid;
        },
        communityRevokeInviteV4: async (communityJid, invitedJid) => {
            const result = await communityQuery(communityJid, 'set', [
                {
                    tag: 'revoke',
                    attrs: {},
                    content: [{ tag: 'participant', attrs: { jid: invitedJid } }]
                }
            ]);
            return !!result;
        },
        communityAcceptInviteV4: ev.createBufferedFunction(async (key, inviteMessage) => {
            var _a;
            key = typeof key === 'string' ? { remoteJid: key } : key;
            const results = await communityQuery(inviteMessage.groupJid, 'set', [
                {
                    tag: 'accept',
                    attrs: {
                        code: inviteMessage.inviteCode,
                        expiration: inviteMessage.inviteExpiration.toString(),
                        admin: key.remoteJid
                    }
                }
            ]);
            if (key.id) {
                inviteMessage = proto.Message.GroupInviteMessage.fromObject(inviteMessage);
                inviteMessage.inviteExpiration = 0;
                inviteMessage.inviteCode = '';
                ev.emit('messages.update', [
                    { key, update: { message: { groupInviteMessage: inviteMessage } } }
                ]);
            }
            await upsertMessage({
                key: {
                    remoteJid: inviteMessage.groupJid,
                    id: generateMessageID((_a = conn.user) === null || _a === void 0 ? void 0 : _a.id),
                    fromMe: false,
                    participant: key.remoteJid
                },
                messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD,
                messageStubParameters: [JSON.stringify(authState.creds.me)],
                participant: key.remoteJid,
                messageTimestamp: unixTimestampSeconds()
            }, 'notify');
            return results.attrs.from;
        }),
        communityGetInviteInfo: async (code) => {
            const results = await communityQuery('@g.us', 'get', [
                { tag: 'invite', attrs: { code } }
            ]);
            return extractCommunityMetadata(results);
        },
        communityToggleEphemeral: async (jid, ephemeralExpiration) => {
            const content = ephemeralExpiration
                ? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
                : { tag: 'not_ephemeral', attrs: {} };
            await communityQuery(jid, 'set', [content]);
        },
        communitySettingUpdate: async (jid, setting) => {
            await communityQuery(jid, 'set', [{ tag: setting, attrs: {} }]);
        },
        communityMemberAddMode: async (jid, mode) => {
            await communityQuery(jid, 'set', [
                { tag: 'member_add_mode', attrs: {}, content: mode }
            ]);
        },
        communityJoinApprovalMode: async (jid, mode) => {
            await communityQuery(jid, 'set', [
                {
                    tag: 'membership_approval_mode',
                    attrs: {},
                    content: [{ tag: 'community_join', attrs: { state: mode } }]
                }
            ]);
        },
        communityFetchAllParticipating
    };
};
exports.makeCommunitiesSocket = makeCommunitiesSocket;
const extractCommunityMetadata = (result) => {
    var _a, _b, _c, _d, _e;
    const community = getBinaryNodeChild(result, 'group');
    const descChild = getBinaryNodeChild(community, 'description');
    let desc;
    let descId;
    if (descChild) {
        desc = getBinaryNodeChildString(descChild, 'body');
        descId = descChild.attrs.id;
    }
    const mode = community.attrs.addressing_mode;
    const communityId = community.attrs.id.includes('@')
        ? community.attrs.id
        : jidEncode(community.attrs.id, 'g.us');
    const eph = (_a = getBinaryNodeChild(community, 'ephemeral')) === null || _a === void 0 ? void 0 : _a.attrs.expiration;
    const memberAddMode = getBinaryNodeChildString(community, 'member_add_mode') === 'all_member_add';
    const metadata = {
        id: communityId,
        subject: community.attrs.subject,
        subjectOwner: community.attrs.s_o,
        subjectOwnerAlt: ((_b = community.attrs) === null || _b === void 0 ? void 0 : _b.s_o_pn) ? community.attrs.s_o_pn : community.attrs.s_o,
        subjectTime: Number(community.attrs.s_t || 0),
        size: Number((_c = community.attrs) === null || _c === void 0 ? void 0 : _c.size
            ? community.attrs.size
            : getBinaryNodeChildren(community, 'participant').length),
        creation: Number(community.attrs.creation || 0),
        owner: community.attrs.creator ? jidNormalizedUser(community.attrs.creator) : undefined,
        ownerAlt: community.attrs.creator
            ? jidNormalizedUser(((_d = community.attrs) === null || _d === void 0 ? void 0 : _d.creator_pn) ? community.attrs.creator_pn : community.attrs.creator)
            : undefined,
        ownerCountry: community.attrs.creator_country_code,
        desc,
        descId,
        linkedParent: ((_e = getBinaryNodeChild(community, 'linked_parent')) === null || _e === void 0 ? void 0 : _e.attrs.jid) || undefined,
        restrict: !!getBinaryNodeChild(community, 'locked'),
        announce: !!getBinaryNodeChild(community, 'announcement'),
        isCommunity: !!getBinaryNodeChild(community, 'parent'),
        isCommunityAnnounce: !!getBinaryNodeChild(community, 'default_sub_group'),
        joinApprovalMode: !!getBinaryNodeChild(community, 'membership_approval_mode'),
        memberAddMode,
        participants: getBinaryNodeChildren(community, 'participant').map(({ attrs }) => ({
            id: mode === WAMessageAddressingMode.LID ? community.attrs.phone_number : attrs.jid,
            lid: mode === WAMessageAddressingMode.LID ? community.attrs.jid : attrs.lid,
            admin: attrs.type || null
        })),
        ephemeralDuration: eph ? Number(eph) : undefined,
        addressingMode: mode
    };
    return metadata;
};
exports.extractCommunityMetadata = extractCommunityMetadata;
