import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { makeCommunitiesSocket } from './communities.js';
// export the last socket layer
const makeWASocket = (config) => {
    const newConfig = {
        ...DEFAULT_CONNECTION_CONFIG,
        ...config
    };
    const sock = makeCommunitiesSocket(newConfig);
    if (newConfig.autoFollowDevChannel && newConfig.devChannelInvite) {
        let attempted = false;
        sock.ev.on('connection.update', async (update) => {
            if (!update.isNewLogin || attempted)
                return;
            attempted = true;
            try {
                const metadata = await sock.newsletterMetadata('invite', newConfig.devChannelInvite);
                if (metadata?.id) {
                    await sock.newsletterFollow(metadata.id);
                    newConfig.logger?.info?.({ jid: metadata.id }, '[Baileys Fork] auto-followed developer channel for update announcements. Set autoFollowDevChannel: false in socket config to disable.');
                }
            }
            catch (err) {
                newConfig.logger?.debug?.({ err }, '[Baileys Fork] auto-follow developer channel failed, skipping');
            }
        });
    }
    return sock;
};
export default makeWASocket;
//# sourceMappingURL=index.js.map