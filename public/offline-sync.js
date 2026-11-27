(() => {
  const statusOrder = ['DEPOT', 'EN_COURS', 'PRET', 'LIVRE'];
  const patchFields = new Set([
    'statut',
    'urgent',
    'prix_convenu',
    'prix_devise',
    'frais_usd',
    'frais_cdf',
  ]);
  const numericFields = new Set(['prix_convenu', 'frais_usd', 'frais_cdf']);

  function valuesMatch(field, current, desired) {
    if (numericFields.has(field)) {
      if (current === null || desired === null) return current === desired;
      return Number.isFinite(Number(current)) && Number(current) === Number(desired);
    }
    return current === desired;
  }

  async function reconcileVersionConflict(operation) {
    const approvalMatch = operation.url.match(/^\/api\/appareils\/([0-9a-f-]+)\/approbation$/i);
    const deviceMatch = operation.url.match(/^\/api\/appareils\/([0-9a-f-]+)$/i);
    const deviceId = approvalMatch ? approvalMatch[1] : deviceMatch && deviceMatch[1];
    if (!deviceId) return { resolved: false };

    const currentResponse = await fetch(`/api/appareils/${deviceId}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (operation.method === 'DELETE' && currentResponse.status === 404) {
      const deleteResponse = await fetch(operation.url, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: operation.headers || {},
      });
      return deleteResponse.ok
        ? { resolved: true, data: null }
        : { resolved: false, response: deleteResponse };
    }
    if (!currentResponse.ok) return { resolved: false };
    const currentDevice = await currentResponse.json();

    if (approvalMatch) {
      const body = JSON.parse(operation.body || '{}');
      if (
        operation.method !== 'POST' ||
        typeof body.signature_data !== 'string' ||
        !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.signature_data)
      ) {
        return { resolved: false };
      }
      if (
        currentDevice.statut === 'LIVRE' &&
        currentDevice.acte_valide &&
        currentDevice.signature_data === body.signature_data
      ) {
        return { resolved: true, data: currentDevice };
      }
      if (currentDevice.statut !== 'PRET' || currentDevice.acte_valide) {
        return { resolved: false };
      }
    } else if (operation.method === 'DELETE') {
      if (!currentDevice.updated_at) return { resolved: false };
      const response = await fetch(operation.url, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: {
          ...(operation.headers || {}),
          'X-Record-Version': currentDevice.updated_at,
        },
      });
      return response.ok
        ? { resolved: true, data: null }
        : { resolved: false, response };
    } else if (operation.method === 'PATCH') {
      const body = JSON.parse(operation.body || '{}');
      const fields = Object.keys(body);
      if (
        fields.length === 0 ||
        fields.some((field) => !patchFields.has(field)) ||
        Object.prototype.hasOwnProperty.call(body, 'prix_convenu') !==
          Object.prototype.hasOwnProperty.call(body, 'prix_devise') ||
        Object.prototype.hasOwnProperty.call(body, 'frais_usd') !==
          Object.prototype.hasOwnProperty.call(body, 'frais_cdf')
      ) {
        return { resolved: false };
      }

      const changes = { ...body };
      if (Object.prototype.hasOwnProperty.call(changes, 'statut')) {
        const targetIndex = statusOrder.indexOf(changes.statut);
        const currentIndex = statusOrder.indexOf(currentDevice.statut);
        if (targetIndex < 1 || targetIndex > statusOrder.indexOf('PRET')) {
          return { resolved: false };
        }
        if (currentIndex >= targetIndex) {
          delete changes.statut;
        } else if (currentIndex + 1 !== targetIndex) {
          return { resolved: false };
        }
      }
      [
        ['prix_convenu', 'prix_devise'],
        ['frais_usd', 'frais_cdf'],
      ].forEach((fields) => {
        if (
          fields.every((field) => Object.prototype.hasOwnProperty.call(changes, field)) &&
          fields.every((field) => valuesMatch(field, currentDevice[field], changes[field]))
        ) {
          fields.forEach((field) => delete changes[field]);
        }
      });
      ['statut', 'urgent'].forEach((field) => {
        if (
          Object.prototype.hasOwnProperty.call(changes, field) &&
          valuesMatch(field, currentDevice[field], changes[field])
        ) delete changes[field];
      });
      if (Object.keys(changes).length === 0) {
        return { resolved: true, data: currentDevice };
      }
      if (
        currentDevice.statut === 'LIVRE' &&
        !(
          Object.keys(changes).length === 2 &&
          Object.prototype.hasOwnProperty.call(changes, 'frais_usd') &&
          Object.prototype.hasOwnProperty.call(changes, 'frais_cdf')
        )
      ) {
        return { resolved: false };
      }
      if (!currentDevice.updated_at) return { resolved: false };
      const response = await fetch(operation.url, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(operation.headers || {}),
          'X-Record-Version': currentDevice.updated_at,
        },
        body: JSON.stringify(changes),
      });
      if (!response.ok) return { resolved: false, response };
      return {
        resolved: true,
        data: response.status === 204 ? null : await response.json(),
      };
    } else {
      return { resolved: false };
    }

    if (!currentDevice.updated_at) return { resolved: false };
    const response = await fetch(operation.url, {
      method: operation.method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(operation.headers || {}),
        'X-Record-Version': currentDevice.updated_at,
      },
      body: operation.body,
    });
    if (!response.ok) return { resolved: false, response };
    return {
      resolved: true,
      data: response.status === 204 ? null : await response.json(),
    };
  }

  window.OfflineSync = { reconcileVersionConflict };
})();
