const api = require('../../utils/api');
const storage = require('../../utils/storage');
const fileUtils = require('../../utils/file');

const ICON_TEXT = {
  pdf: 'P', image: '▧', word: 'W', sheet: 'X', ppt: 'P', zip: 'Z', file: 'F',
};

Page({
  data: {
    user: {},
    isTeacher: false,
    roleText: '学生账号',
    activeCategory: 'A',
    currentCategory: { code: 'A', name: 'A 类文件', count: 0 },
    categories: [
      { code: 'A', name: 'A 类文件', count: 0 },
      { code: 'B', name: 'B 类文件', count: 0 },
      { code: 'C', name: 'C 类文件', count: 0 },
      { code: 'D', name: 'D 类文件', count: 0 },
      { code: 'E', name: 'E 类文件', count: 0 },
    ],
    files: [],
    filteredFiles: [],
    keyword: '',
    hideMarked: false,
    loading: false,
    uploading: false,
    exporting: false,
    uploadProgress: 0,
    uploadFileCount: 0,
    totalCount: 0,
    markedCount: 0,
  },

  onLoad() {
    const token = storage.getToken();
    const user = storage.getUser();
    if (!token || !user) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }

    this.setUser(user);
    this.loadPage();
  },

  onPullDownRefresh() {
    this.refreshFiles().finally(() => wx.stopPullDownRefresh());
  },

  setUser(user) {
    const isTeacher = user && user.role === 'teacher';
    this.setData({
      user: user || {},
      isTeacher,
      roleText: isTeacher ? '教师账号' : '学生账号',
    });
  },

  async loadPage() {
    await Promise.all([this.fetchCounts(), this.fetchFiles()]);
  },

  async guardAuthError(error) {
    if (error && error.statusCode === 401) {
      storage.clearSession({ keepRememberToken: true });
      wx.showToast({ title: '登录已过期', icon: 'none' });
      setTimeout(() => wx.reLaunch({ url: '/pages/login/login' }), 400);
      return true;
    }
    return false;
  },

  async fetchCounts() {
    try {
      const counts = await api.counts();
      const categories = this.data.categories.map((item) => ({
        ...item,
        count: Number((counts && counts[item.code]) || 0),
      }));
      const totalCount = categories.reduce((sum, item) => sum + Number(item.count || 0), 0);
      this.setData({ categories, totalCount });
      this.updateCurrentCategory(categories, this.data.activeCategory);
    } catch (error) {
      if (!(await this.guardAuthError(error))) {
        console.warn('获取分类数量失败:', error);
      }
    }
  },

  async fetchFiles() {
    const requestId =
      Number(this._filesRequestId || 0) + 1;

    this._filesRequestId = requestId;

    this.setData({ loading: true });

    try {
      const category = this.data.activeCategory;

      const [rows, markData] = await Promise.all([
        api.files(category),
        api.marks(category),
      ]);

      if (
        requestId !==
        this._filesRequestId
      ) {
        return;
      }

      const markedIds = new Set(
        Array.isArray(markData && markData.fileIds)
          ? markData.fileIds.map((id) => Number(id))
          : [],
      );

      const files = (Array.isArray(rows) ? rows : []).map((item) => {
        const iconType = fileUtils.iconType(item.original_name);
        return {
          ...item,
          marked: markedIds.has(Number(item.id)),
          readableType: fileUtils.readableType(item),
          formattedSize: fileUtils.formatFileSize(item.file_size),
          formattedDate: fileUtils.formatDate(item.created_at),
          uploaderName:
  item.uploader_name ||
  '未知',
          iconType,
          iconText: ICON_TEXT[iconType] || 'F',
        };
      });

      this.setData({ files }, () => this.applyFilter());
    } catch (error) {
      if (
        requestId ===
        this._filesRequestId
      ) {
        this.setData({
          files: [],
          filteredFiles: [],
        });

        if (!(await this.guardAuthError(error))) {
          wx.showToast({
            title:
              error.message ||
              '读取文件失败',
            icon: 'none',
          });
        }
      }
    } finally {
      if (
        requestId ===
        this._filesRequestId
      ) {
        this.setData({
          loading: false,
        });
      }
    }
  },

  updateCurrentCategory(categories, code) {
    const currentCategory = categories.find((item) => item.code === code) || categories[0];
    this.setData({ currentCategory });
  },

  async selectCategory(event) {
    const code =
      event.currentTarget.dataset.code;

    if (
      !code ||
      code === this.data.activeCategory
    ) {
      return;
    }

    if (this.data.uploading) {
      wx.showToast({
        title: '请等待文件导入完成',
        icon: 'none',
      });
      return;
    }

    this.setData({
      activeCategory: code,
      keyword: '',
    });

    this.updateCurrentCategory(
      this.data.categories,
      code,
    );

    await this.fetchFiles();
  },

  onKeywordInput(event) {
    this.setData({ keyword: event.detail.value }, () => this.applyFilter());
  },

  onHideMarkedChange(event) {
    const values =
      (event.detail && event.detail.value) || [];

    this.setData(
      {
        hideMarked:
          Array.isArray(values) &&
          values.includes('hideMarked'),
      },
      () => this.applyFilter(),
    );
  },

  applyFilter() {
    const keyword =
      String(this.data.keyword || '')
        .trim()
        .toLowerCase();

    const hideMarked =
      Boolean(this.data.hideMarked);

    const filteredFiles =
      this.data.files.filter((item) => {
        const matchesKeyword =
          !keyword ||
          String(item.original_name || '')
            .toLowerCase()
            .includes(keyword);

        const matchesMarked =
          !hideMarked ||
          !item.marked;

        return (
          matchesKeyword &&
          matchesMarked
        );
      });

    const markedCount = this.data.files.filter((item) => Boolean(item.marked)).length;
    this.setData({ filteredFiles, markedCount });
  },

  async onFileMarkChange(event) {
    const fileId =
      Number(
        event.currentTarget.dataset.id,
      );

    const values =
      (event.detail && event.detail.value) || [];

    const marked =
      Array.isArray(values) &&
      values.includes('marked');

    const markCategory =
      this.data.activeCategory;

    if (
      !Number.isInteger(fileId) ||
      fileId <= 0
    ) {
      return;
    }

    const targetFile =
      this.data.files.find(
        (item) =>
          Number(item.id) === fileId,
      );

    if (
      !targetFile ||
      targetFile.markSaving
    ) {
      return;
    }

    const previousFiles =
      this.data.files;

    const nextFiles =
      previousFiles.map((item) =>
        Number(item.id) === fileId
          ? {
              ...item,
              marked,
              markSaving: true,
            }
          : item
      );

    this.setData(
      {
        files: nextFiles,
      },
      () => this.applyFilter(),
    );

    try {
      await api.setMarked(
        fileId,
        marked,
      );

      if (
        this.data.activeCategory ===
        markCategory
      ) {
        this.setData(
          {
            files:
              this.data.files.map(
                (item) =>
                  Number(item.id) ===
                  fileId
                    ? {
                        ...item,
                        markSaving: false,
                      }
                    : item
              ),
          },
          () => this.applyFilter(),
        );
      }
    } catch (error) {
      if (
        this.data.activeCategory ===
        markCategory
      ) {
        this.setData(
          {
            files: previousFiles,
          },
          () => this.applyFilter(),
        );
      }

      if (!(await this.guardAuthError(error))) {
        wx.showToast({
          title:
            error.message ||
            '更新标记失败',
          icon: 'none',
        });
      }
    }
  },

  async refreshFiles() {
    await Promise.all([this.fetchCounts(), this.fetchFiles()]);
    wx.showToast({ title: '刷新成功', icon: 'success' });
  },

/**
 * 判断当前运行环境。
 *
 * devtools / windows / mac：
 * 按电脑端处理。
 *
 * ios / android：
 * 按手机端处理。
 */
getRuntimePlatform() {
  try {
    if (typeof wx.getDeviceInfo === 'function') {
      const info = wx.getDeviceInfo();
      return String(info.platform || '').toLowerCase();
    }

    const info = wx.getSystemInfoSync();
    return String(info.platform || '').toLowerCase();
  } catch (error) {
    console.warn('获取设备类型失败：', error);
    return '';
  }
},

isDesktopRuntime() {
  const platform = this.getRuntimePlatform();

  return [
    'devtools',
    'windows',
    'mac',
  ].includes(platform);
},

/**
 * 教师点击“导入文件”。
 *
 * 电脑：
 * 直接打开文件选择器。
 *
 * 手机：
 * 显示不同上传来源。
 *
 * “手机文件”会在下一步接入系统文件浏览器。
 */
chooseFiles() {
  if (
    !this.data.isTeacher ||
    this.data.uploading
  ) {
    return;
  }

  if (this.isDesktopRuntime()) {
    this.chooseComputerFiles();
    return;
  }

  wx.showActionSheet({
    itemList: [
      '从相册选择图片或视频',
      '拍照或录像',
      '从微信聊天选择文件',
    ],

    success: ({ tapIndex }) => {
      if (tapIndex === 0) {
        this.choosePhoneMedia([
          'album',
        ]);
        return;
      }

      if (tapIndex === 1) {
        this.choosePhoneMedia([
          'camera',
        ]);
        return;
      }

      if (tapIndex === 2) {
        this.chooseWechatFiles();
      }
    },

    fail: (error) => {
      if (
        !String(
          error.errMsg || '',
        ).includes('cancel')
      ) {
        wx.showToast({
          title:
            '无法打开文件选择菜单',
          icon: 'none',
        });
      }
    },
  });
},

/**
 * 电脑端上传。
 *
 * 不再区分 PDF / PPT / Word / Excel。
 * 一次文件选择器即可选择资料。
 */
chooseComputerFiles() {
  wx.chooseMessageFile({
    count: 20,
    type: 'all',

    success: (result) => {
      const files =
        (result.tempFiles || [])
          .map((item, index) => {
            const filePath =
              item.path ||
              item.tempFilePath ||
              '';

            if (!filePath) {
              return null;
            }

            return {
              path: filePath,

              name:
                item.name ||
                `文件_${
                  Date.now()
                }_${index + 1}`,

              size:
                Number(
                  item.size || 0,
                ),
            };
          })
          .filter(Boolean);

      if (!files.length) {
        wx.showToast({
          title: '没有选择文件',
          icon: 'none',
        });

        return;
      }

      this.uploadFiles(files);
    },

    fail: (error) => {
      if (
        !String(
          error.errMsg || '',
        ).includes('cancel')
      ) {
        console.error(
          '选择电脑文件失败：',
          error,
        );

        wx.showToast({
          title: '选择文件失败',
          icon: 'none',
        });
      }
    },
  });
},

/**
 * 手机端从微信聊天记录选择普通文件。
 *
 * 这里明确叫“微信聊天文件”，
 * 避免用户误以为是在浏览手机文件管理器。
 */
chooseWechatFiles() {
  wx.chooseMessageFile({
    count: 20,
    type: 'file',

    success: (result) => {
      const files =
        (result.tempFiles || [])
          .map((item, index) => {
            const filePath =
              item.path ||
              item.tempFilePath ||
              '';

            if (!filePath) {
              return null;
            }

            return {
              path: filePath,

              name:
                item.name ||
                `微信文件_${
                  Date.now()
                }_${index + 1}`,

              size:
                Number(
                  item.size || 0,
                ),
            };
          })
          .filter(Boolean);

      if (!files.length) {
        wx.showToast({
          title: '没有选择文件',
          icon: 'none',
        });

        return;
      }

      this.uploadFiles(files);
    },

    fail: (error) => {
      if (
        !String(
          error.errMsg || '',
        ).includes('cancel')
      ) {
        console.error(
          '选择微信文件失败：',
          error,
        );

        wx.showToast({
          title:
            '选择微信文件失败',
          icon: 'none',
        });
      }
    },
  });
},
/**
 * 从手机相册或相机选择图片、视频。
 */
choosePhoneMedia(sourceType) {
  if (typeof wx.chooseMedia !== 'function') {
    wx.showModal({
      title: '当前微信版本不支持',
      content: '请升级微信后再从手机相册选择文件。',
      showCancel: false,
    });
    return;
  }

  wx.chooseMedia({
    count: 9,
    mediaType: ['image', 'video'],
    sourceType,
    sizeType: ['original', 'compressed'],
    maxDuration: 60,
    camera: 'back',

    success: (result) => {
      const files = (result.tempFiles || [])
        .map((item, index) => {
          const filePath = item.tempFilePath || item.path;

          if (!filePath) {
            return null;
          }

          const isVideo =
            Number(item.duration || 0) > 0 ||
            Boolean(item.thumbTempFilePath);

          return {
            path: filePath,
            name: this.createMediaFileName(
              filePath,
              index,
              isVideo ? '视频' : '图片',
              isVideo ? 'mp4' : 'jpg',
            ),
            size: Number(item.size || 0),
          };
        })
        .filter(Boolean);

      if (files.length > 0) {
        this.uploadFiles(files);
      }
    },

    fail: (error) => {
      if (!String(error.errMsg || '').includes('cancel')) {
        wx.showToast({
          title: '选择手机文件失败',
          icon: 'none',
        });
      }
    },
  });
},

/**
 * 为手机相册中的图片或视频生成文件名。
 *
 * 有些手机不会返回原始文件名，所以主动生成一个可识别的名称。
 */
createMediaFileName(
  filePath,
  index = 0,
  label = '文件',
  fallbackExtension = 'dat',
) {
  const cleanPath = String(filePath || '').split('?')[0];

  const extensionMatch = cleanPath.match(
    /\.([a-zA-Z0-9]{1,12})$/,
  );

  const extension = extensionMatch
    ? extensionMatch[1].toLowerCase()
    : fallbackExtension;

  const date = new Date();

  const pad = (value) => String(value).padStart(2, '0');

  const timestamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');

  return `${label}_${timestamp}_${index + 1}.${extension}`;
},

  async uploadFiles(files) {
    const uploadCategory =
      this.data.activeCategory;

    this.setData({
      uploading: true,
      uploadProgress: 0,
      uploadFileCount: files.length,
    });

    let uploaded = 0;
    try {
      for (let index = 0; index < files.length; index += 1) {
        const current = files[index];
        await api.uploadOne({
          category: uploadCategory,
          filePath: current.path,
          fileName: current.name,
          fileSize: current.size,
          onProgress: (progress) => {
            const aggregate = Math.round(((index + progress / 100) / files.length) * 100);
            this.setData({ uploadProgress: aggregate });
          },
        });
        uploaded += 1;
      }

      await Promise.all([this.fetchCounts(), this.fetchFiles()]);
      wx.showModal({
        title: '导入完成',
        content: `已成功导入 ${uploaded} 个文件到 ${uploadCategory} 类。`,
        showCancel: false,
      });
    } catch (error) {
      if (!(await this.guardAuthError(error))) {
        wx.showModal({
          title: '导入未完成',
          content: `已成功 ${uploaded} 个，失败原因：${error.message || '上传失败'}`,
          showCancel: false,
        });
      }
      await Promise.all([this.fetchCounts(), this.fetchFiles()]);
    } finally {
      this.setData({
        uploading: false,
        uploadProgress: 0,
        uploadFileCount: 0,
      });
    }
  },

  async downloadFile(event) {
    const file = this.data.filteredFiles[Number(event.currentTarget.dataset.index)];
    if (!file) return;

    wx.showLoading({ title: '正在导出', mask: true });
    try {
      const result = await api.download({
        path: `/api/files/${file.id}/download`,
        fileName: file.original_name,
      });
      wx.hideLoading();
      await fileUtils.previewOrShare(result.tempFilePath, file.original_name);
    } catch (error) {
      wx.hideLoading();
      if (!(await this.guardAuthError(error))) {
        wx.showToast({ title: error.message || '导出失败', icon: 'none' });
      }
    }
  },

  async exportCategory() {
    if (this.data.exporting || this.data.files.length === 0) return;
    this.setData({ exporting: true });
    wx.showLoading({ title: '正在生成 ZIP', mask: true });

    const zipName = `${this.data.activeCategory}类文件_${fileUtils.todayText()}.zip`;
    try {
      const result = await api.download({
        path: `/api/files/export/${this.data.activeCategory}`,
        fileName: zipName,
      });
      wx.hideLoading();
      await fileUtils.previewOrShare(result.tempFilePath, zipName);
    } catch (error) {
      wx.hideLoading();
      if (!(await this.guardAuthError(error))) {
        wx.showToast({ title: error.message || 'ZIP 导出失败', icon: 'none' });
      }
    } finally {
      this.setData({ exporting: false });
    }
  },

  deleteFile(event) {
    if (!this.data.isTeacher) return;
    const file = this.data.filteredFiles[Number(event.currentTarget.dataset.index)];
    if (!file) return;

    wx.showModal({
      title: '确认删除',
      content: `确定删除“${file.original_name}”吗？删除后服务器文件和数据库记录都会被移除。`,
      confirmText: '删除',
      confirmColor: '#d9363e',
      success: async (result) => {
        if (!result.confirm) return;
        wx.showLoading({ title: '正在删除', mask: true });
        try {
          await api.deleteFile(file.id);
          await Promise.all([this.fetchCounts(), this.fetchFiles()]);
          wx.showToast({ title: '删除成功', icon: 'success' });
        } catch (error) {
          if (!(await this.guardAuthError(error))) {
            wx.showToast({ title: error.message || '删除失败', icon: 'none' });
          }
        } finally {
          wx.hideLoading();
        }
      },
    });
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后将返回登录页面；已记住的设备也会失效。',
      confirmText: '退出',
      success: async (result) => {
        if (!result.confirm) return;
        const rememberToken = storage.getRememberToken();
        try {
          await api.logout(rememberToken);
        } catch (error) {
          console.warn('后端退出失败，继续清理本地登录状态:', error);
        }
        storage.clearSession();
        getApp().globalData.user = null;
        wx.reLaunch({ url: '/pages/login/login' });
      },
    });
  },
});
